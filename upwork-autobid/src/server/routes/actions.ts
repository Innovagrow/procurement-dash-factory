import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { publicUrl } from '../../config/env';
import { toErrorMessage } from '../../lib/errors';
import { child } from '../../lib/logger';
import { prisma } from '../../lib/prisma';
import { approveProposal, rejectProposal } from '../../submit';
import { verifyAction } from '../../submit/review-queue';
import { emit } from '../sse';

const log = child('api:actions');

/**
 * One-tap endpoints for the buttons in a Telegram message or an email. They
 * carry no API key: the HMAC token in the query string is the credential, and a
 * human opens them in a browser, so every answer is a small HTML page.
 */

const paramsSchema = z.object({ proposalId: z.string().trim().min(1).max(64) });
const aliasParamsSchema = z.object({ id: z.string().trim().min(1).max(64) });
const querySchema = z.object({
  token: z.string().trim().min(16).max(256),
  reason: z.string().trim().max(300).optional(),
});

type Action = 'approve' | 'reject';

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

interface PageOptions {
  title: string;
  heading: string;
  tone: 'ok' | 'warn' | 'error';
  lines: string[];
  proposalId?: string;
}

function renderPage(options: PageOptions): string {
  const accent =
    options.tone === 'ok' ? '#16a34a' : options.tone === 'warn' ? '#d97706' : '#dc2626';
  const body = options.lines.map((line) => `<p>${escapeHtml(line)}</p>`).join('\n      ');
  const link = options.proposalId
    ? publicUrl(`/#/proposals/${encodeURIComponent(options.proposalId)}`)
    : publicUrl('/');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="robots" content="noindex" />
    <title>${escapeHtml(options.title)}</title>
    <style>
      :root { color-scheme: dark; }
      body {
        margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
        font: 15px/1.55 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
        background: #0f172a; color: #e2e8f0; padding: 24px;
      }
      .card {
        max-width: 460px; width: 100%; background: #1e293b; border: 1px solid #334155;
        border-radius: 14px; padding: 28px; box-shadow: 0 18px 40px rgba(0,0,0,.35);
      }
      h1 { margin: 0 0 12px; font-size: 19px; color: ${accent}; }
      p { margin: 0 0 10px; color: #cbd5e1; }
      a.button {
        display: inline-block; margin-top: 14px; padding: 9px 16px; border-radius: 8px;
        background: #2563eb; color: #fff; text-decoration: none; font-weight: 600;
      }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>${escapeHtml(options.heading)}</h1>
      ${body}
      <a class="button" href="${escapeHtml(link)}">Open in the dashboard</a>
    </div>
  </body>
</html>`;
}

function sendPage(reply: FastifyReply, status: number, options: PageOptions): FastifyReply {
  return reply
    .code(status)
    .header('Content-Type', 'text/html; charset=utf-8')
    .header('Cache-Control', 'no-store')
    .send(renderPage(options));
}

function actorFor(request: FastifyRequest): string {
  const agent = request.headers['user-agent'];
  const label = typeof agent === 'string' && agent.toLowerCase().includes('telegram')
    ? 'telegram'
    : 'one-tap-link';
  return label;
}

async function handleAction(
  action: Action,
  proposalId: string,
  request: FastifyRequest,
  reply: FastifyReply,
): Promise<FastifyReply> {
  const query = querySchema.safeParse(request.query ?? {});
  if (!query.success) {
    return sendPage(reply, 400, {
      title: 'UpBid',
      heading: 'Missing token',
      tone: 'error',
      lines: ['This link is incomplete. Open the proposal in the dashboard instead.'],
      proposalId,
    });
  }

  if (!verifyAction(proposalId, action, query.data.token)) {
    log.warn({ proposalId, action, ip: request.ip }, 'rejected a one-tap action with a bad token');
    return sendPage(reply, 403, {
      title: 'UpBid',
      heading: 'This link is not valid',
      tone: 'error',
      lines: [
        'The signature did not match. Links expire when API_KEY is rotated.',
        'Open the proposal in the dashboard and act there.',
      ],
      proposalId,
    });
  }

  const proposal = await prisma.proposal.findUnique({
    where: { id: proposalId },
    select: { id: true, status: true, job: { select: { title: true } } },
  });

  if (!proposal) {
    return sendPage(reply, 404, {
      title: 'UpBid',
      heading: 'Proposal not found',
      tone: 'error',
      lines: ['It may have been deleted along with its job posting.'],
    });
  }

  const jobTitle = proposal.job.title;

  // Idempotency: a second tap on the same button must never send a second
  // proposal, so terminal states answer without touching the dispatcher.
  if (action === 'approve' && proposal.status === 'SUBMITTED') {
    return sendPage(reply, 200, {
      title: 'UpBid',
      heading: 'Already submitted',
      tone: 'ok',
      lines: [jobTitle, 'This proposal was already sent. Nothing was done twice.'],
      proposalId,
    });
  }
  if (action === 'reject' && proposal.status === 'REJECTED') {
    return sendPage(reply, 200, {
      title: 'UpBid',
      heading: 'Already rejected',
      tone: 'warn',
      lines: [jobTitle, 'This proposal was already rejected.'],
      proposalId,
    });
  }
  if (action === 'approve' && proposal.status === 'SUBMITTING') {
    return sendPage(reply, 200, {
      title: 'UpBid',
      heading: 'Submission in flight',
      tone: 'warn',
      lines: [jobTitle, 'A submission for this proposal is already running.'],
      proposalId,
    });
  }

  const actor = actorFor(request);

  try {
    const outcome =
      action === 'approve'
        ? await approveProposal(proposalId, actor)
        : await rejectProposal(proposalId, actor, query.data.reason);

    emit(action === 'approve' ? 'proposal.approved' : 'proposal.rejected', {
      proposalId,
      status: outcome.status,
      ok: outcome.ok,
      via: actor,
    });

    log.info({ proposalId, action, actor, ok: outcome.ok, status: outcome.status }, 'one-tap action');

    if (!outcome.ok) {
      return sendPage(reply, 409, {
        title: 'UpBid',
        heading: action === 'approve' ? 'Could not approve' : 'Could not reject',
        tone: 'warn',
        lines: [jobTitle, outcome.message, `Current status: ${String(outcome.status)}`],
        proposalId,
      });
    }

    return sendPage(reply, 200, {
      title: 'UpBid',
      heading: action === 'approve' ? 'Approved' : 'Rejected',
      tone: action === 'approve' ? 'ok' : 'warn',
      lines: [jobTitle, outcome.message, `Status: ${String(outcome.status)}`],
      proposalId,
    });
  } catch (err) {
    log.error({ err: toErrorMessage(err), proposalId, action }, 'one-tap action failed');
    return sendPage(reply, 500, {
      title: 'UpBid',
      heading: 'Something went wrong',
      tone: 'error',
      lines: [jobTitle, 'The action could not be completed. Open the dashboard and retry.'],
      proposalId,
    });
  }
}

export default async function actionRoutes(app: FastifyInstance): Promise<void> {
  app.get('/actions/approve/:proposalId', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return sendPage(reply, 400, {
        title: 'UpBid',
        heading: 'Invalid link',
        tone: 'error',
        lines: ['The proposal id in this link is malformed.'],
      });
    }
    return handleAction('approve', params.data.proposalId, request, reply);
  });

  app.get('/actions/reject/:proposalId', async (request, reply) => {
    const params = paramsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return sendPage(reply, 400, {
        title: 'UpBid',
        heading: 'Invalid link',
        tone: 'error',
        lines: ['The proposal id in this link is malformed.'],
      });
    }
    return handleAction('reject', params.data.proposalId, request, reply);
  });

  // The notification builder signs /api/proposals/:id/{approve,reject} links.
  // The POST variants of those paths belong to the proposals routes and are API
  // key protected; these GET twins are the token-protected browser entry points.
  app.get('/proposals/:id/approve', async (request, reply) => {
    const params = aliasParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return sendPage(reply, 400, {
        title: 'UpBid',
        heading: 'Invalid link',
        tone: 'error',
        lines: ['The proposal id in this link is malformed.'],
      });
    }
    return handleAction('approve', params.data.id, request, reply);
  });

  app.get('/proposals/:id/reject', async (request, reply) => {
    const params = aliasParamsSchema.safeParse(request.params ?? {});
    if (!params.success) {
      return sendPage(reply, 400, {
        title: 'UpBid',
        heading: 'Invalid link',
        tone: 'error',
        lines: ['The proposal id in this link is malformed.'],
      });
    }
    return handleAction('reject', params.data.id, request, reply);
  });
}

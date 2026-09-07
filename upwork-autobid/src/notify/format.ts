/**
 * Message builders. Everything the operator reads on their phone is shaped here,
 * so every channel renders the same facts in the same order.
 *
 * Bodies follow one layout: a title line, then a block of "Label: value" fact
 * lines, then a blank line, then free text. parseMessageFacts() reverses it,
 * which is how the Slack channel turns a message into Block Kit fields.
 */

import { publicUrl } from '../config/env';
import { humanizeAge } from '../lib/time';
import { buildActionUrl, buildProposalUrl } from '../submit/review-queue';
import type {
  NotificationAction,
  NotificationMessage,
  PipelineStats,
  RedFlag,
  RedFlagSeverity,
} from '../types';

export const SUBJECT_MAX = 140;
export const COVER_LETTER_PREVIEW_CHARS = 420;
export const SCORE_BAR_WIDTH = 10;

/* ------------------------------------------------------------------- views */

/**
 * Structural views rather than Prisma row types: a Job/Proposal row assigns to
 * these directly, and tests can build one without a database.
 */
export interface NotifyJobView {
  id: string;
  title: string;
  url: string;
  jobType?: string | null;
  budgetAmount?: number | null;
  hourlyMin?: number | null;
  hourlyMax?: number | null;
  currency?: string | null;
  durationLabel?: string | null;
  postedAt?: Date | string | null;
  firstSeenAt?: Date | string | null;
  proposalsCount?: number | null;
  interviewingCount?: number | null;
  connectsRequired?: number | null;
  skills?: string[] | null;
  clientCountry?: string | null;
  clientPaymentVerified?: boolean | null;
  clientTotalSpent?: number | null;
  clientAvgRating?: number | null;
  clientReviewsCount?: number | null;
  clientHireRate?: number | null;
  clientTotalHires?: number | null;
}

export interface NotifyMatchView {
  score: number;
  decision?: string | null;
  reasons?: string[] | null;
  /** Prisma stores this as Json; toRedFlags() narrows whatever comes back. */
  redFlags?: unknown;
  matchedSkills?: string[] | null;
  matchedKeywords?: string[] | null;
  llmScore?: number | null;
  llmRationale?: string | null;
}

export interface NotifyProposalView {
  id: string;
  coverLetter: string;
  bidAmount?: number | null;
  hourlyRate?: number | null;
  estimatedDurationLabel?: string | null;
  connectsCost?: number | null;
}

export interface NotifyProfileView {
  id?: string | null;
  name: string;
  hourlyRate?: number | null;
}

export interface MessageFact {
  label: string;
  value: string;
}

/* --------------------------------------------------------------- primitives */

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function truncate(text: string, max: number): string {
  const normalized = (text ?? '').replace(/\r\n/g, '\n').trim();
  if (normalized.length <= max) return normalized;
  return `${normalized.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

/** Collapses newlines so a value never breaks the "Label: value" line layout. */
export function oneLine(text: string): string {
  return (text ?? '').replace(/\s+/g, ' ').trim();
}

export function escapeHtml(value: string): string {
  return (value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function currencySymbol(code: string): string {
  switch (code.toUpperCase()) {
    case 'USD':
      return '$';
    case 'EUR':
      return 'EUR ';
    case 'GBP':
      return 'GBP ';
    default:
      return `${code.toUpperCase()} `;
  }
}

export function formatMoney(amount: number | null | undefined, currency = 'USD'): string {
  const value = num(amount);
  if (value === null) return 'n/a';
  const code = (currency || 'USD').toUpperCase();
  const digits = Number.isInteger(value) ? 0 : 2;
  try {
    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency: code,
      minimumFractionDigits: digits,
      maximumFractionDigits: digits,
    }).format(value);
  } catch {
    // Unknown ISO code: Intl throws rather than degrading, so do it by hand.
    return `${currencySymbol(code)}${value.toFixed(digits)}`;
  }
}

/** "$128k", "$1.4M" - keeps client stats short enough for a phone banner. */
export function compactMoney(amount: number | null | undefined, currency = 'USD'): string {
  const value = num(amount);
  if (value === null) return 'n/a';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  const symbol = currencySymbol((currency || 'USD').toUpperCase());
  if (abs >= 1_000_000) return `${symbol}${sign}${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1_000) return `${symbol}${sign}${Math.round(abs / 1_000)}k`;
  return formatMoney(value, currency);
}

/** "[########..] 82" using block glyphs; readable in every notification client. */
export function scoreBar(score: number | null | undefined, width = SCORE_BAR_WIDTH): string {
  const value = num(score);
  if (value === null) return 'unscored';
  const clamped = Math.max(0, Math.min(100, Math.round(value)));
  const filled = Math.max(0, Math.min(width, Math.round((clamped / 100) * width)));
  return `[${'█'.repeat(filled)}${'░'.repeat(width - filled)}] ${clamped}`;
}

/* ---------------------------------------------------------------- job facts */

export function formatBudget(job: NotifyJobView): string {
  const currency = job.currency ?? 'USD';
  const type = String(job.jobType ?? 'UNKNOWN').toUpperCase();
  const min = num(job.hourlyMin);
  const max = num(job.hourlyMax);

  let hourly: string | null = null;
  if (min !== null && max !== null && max > min) {
    hourly = `${formatMoney(min, currency)}-${formatMoney(max, currency)}/hr`;
  } else if (min !== null || max !== null) {
    hourly = `${formatMoney(min ?? max, currency)}/hr`;
  }

  const budget = num(job.budgetAmount);
  const fixed = budget === null ? null : `${formatMoney(budget, currency)} fixed`;

  if (type === 'HOURLY') return hourly ?? fixed ?? 'rate not stated';
  const primary = fixed ?? hourly;
  if (primary === null) return 'budget not stated';
  if (job.durationLabel) return `${primary}, ${oneLine(job.durationLabel)}`;
  return primary;
}

export function formatClient(job: NotifyJobView): string {
  const parts: string[] = [];
  if (job.clientCountry) parts.push(oneLine(job.clientCountry));
  if (job.clientPaymentVerified === true) parts.push('payment verified');
  else if (job.clientPaymentVerified === false) parts.push('UNVERIFIED');

  const spent = num(job.clientTotalSpent);
  if (spent !== null) parts.push(`${compactMoney(spent, job.currency ?? 'USD')} spent`);

  const rating = num(job.clientAvgRating);
  const reviews = num(job.clientReviewsCount);
  if (rating !== null) {
    parts.push(reviews === null ? `${rating.toFixed(1)}/5` : `${rating.toFixed(1)}/5 (${reviews})`);
  }

  const hireRate = num(job.clientHireRate);
  if (hireRate !== null) {
    const pct = hireRate <= 1 ? hireRate * 100 : hireRate;
    parts.push(`${Math.round(pct)}% hire rate`);
  }

  return parts.length > 0 ? parts.join(', ') : 'no client history';
}

export function formatCompetition(job: NotifyJobView): string {
  const proposals = num(job.proposalsCount);
  const interviewing = num(job.interviewingCount);
  const parts: string[] = [];
  if (proposals !== null) parts.push(`${proposals} proposal${proposals === 1 ? '' : 's'}`);
  if (interviewing !== null) parts.push(`${interviewing} interviewing`);
  return parts.length > 0 ? parts.join(', ') : 'unknown';
}

export function formatPosted(job: NotifyJobView): string {
  return humanizeAge(job.postedAt ?? job.firstSeenAt ?? null);
}

const SEVERITY_RANK: Record<RedFlagSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };

function isSeverity(value: unknown): value is RedFlagSeverity {
  return value === 'LOW' || value === 'MEDIUM' || value === 'HIGH';
}

/** Narrows a Prisma Json column (or a ScoreResult field) to RedFlag[]. */
export function toRedFlags(value: unknown): RedFlag[] {
  if (!Array.isArray(value)) return [];
  const flags: RedFlag[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const message = typeof record.message === 'string' ? record.message.trim() : '';
    if (message === '') continue;
    flags.push({
      code: typeof record.code === 'string' ? record.code : 'unknown',
      severity: isSeverity(record.severity) ? record.severity : 'LOW',
      message,
    });
  }
  return flags.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
}

function formatRedFlags(value: unknown, limit = 3): string | null {
  const flags = toRedFlags(value).slice(0, limit);
  if (flags.length === 0) return null;
  return flags.map((flag) => `${flag.severity} ${oneLine(flag.message)}`).join('; ');
}

function formatReasons(reasons: string[] | null | undefined, limit = 3): string | null {
  if (!Array.isArray(reasons)) return null;
  const cleaned = reasons.map(oneLine).filter((reason) => reason.length > 0).slice(0, limit);
  return cleaned.length > 0 ? cleaned.join('; ') : null;
}

/* -------------------------------------------------------------- body layout */

export function renderBody(title: string, facts: MessageFact[], sections: string[] = []): string {
  const head = [oneLine(title), ...facts.map((fact) => `${fact.label}: ${oneLine(fact.value)}`)]
    .filter((line) => line.length > 0)
    .join('\n');
  const tail = sections
    .map((section) => (section ?? '').trim())
    .filter((section) => section.length > 0)
    .join('\n\n');
  return tail === '' ? head : `${head}\n\n${tail}`;
}

/**
 * Labels we are willing to lift out of a body into structured fields. An
 * allowlist keeps a title such as "Bugfix: crash on save" from being mistaken
 * for a fact when the message came from somewhere other than this module.
 */
const KNOWN_FACT_LABELS = new Set([
  'score',
  'decision',
  'budget',
  'bid',
  'rate',
  'client',
  'competition',
  'posted',
  'age',
  'profile',
  'skills',
  'reasons',
  'red flags',
  'connects',
  'duration',
  'status',
  'submitter',
  'component',
  'severity',
  'kind',
  'detail',
  'error',
  'quota',
  'source',
  'ref',
  'job',
  'model',
  'seen',
  'scored',
  'drafted',
  'submitted',
  'pending',
  'avg score',
  'failures',
  'period',
]);

export interface ParsedMessage {
  title: string;
  facts: MessageFact[];
  rest: string;
}

interface FactScan {
  facts: MessageFact[];
  other: string[];
}

function scanFactBlock(block: string): FactScan {
  const facts: MessageFact[] = [];
  const other: string[] = [];

  for (const line of block.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    // A single line may carry several facts separated by wide gaps or middots.
    for (const segment of trimmed.split(/\s{2,}|\s+·\s+/)) {
      const candidate = segment.trim();
      if (candidate === '') continue;
      const match = candidate.match(/^([A-Za-z][A-Za-z0-9 \/_-]{0,20}):\s*(.+)$/);
      const label = match?.[1]?.trim();
      const value = match?.[2]?.trim();
      if (label && value && KNOWN_FACT_LABELS.has(label.toLowerCase())) {
        facts.push({ label, value });
      } else {
        other.push(candidate);
      }
    }
  }

  return { facts, other };
}

/** Inverse of renderBody(). Unknown shapes degrade to "everything is rest". */
export function parseMessageFacts(body: string): ParsedMessage {
  const normalized = (body ?? '').replace(/\r\n/g, '\n');
  const split = normalized.indexOf('\n\n');
  const head = split === -1 ? normalized : normalized.slice(0, split);
  let rest = split === -1 ? '' : normalized.slice(split + 2).trim();

  const scanned = scanFactBlock(head);
  let facts = scanned.facts;

  // Messages built elsewhere often put the fact block after the title's blank
  // line; lift it so Slack still gets fields instead of one wall of text.
  if (facts.length === 0 && rest !== '') {
    const nextSplit = rest.indexOf('\n\n');
    const block = nextSplit === -1 ? rest : rest.slice(0, nextSplit);
    const blockScan = scanFactBlock(block);
    if (blockScan.facts.length > 0) {
      facts = blockScan.facts;
      const remainder = nextSplit === -1 ? '' : rest.slice(nextSplit + 2);
      rest = [blockScan.other.join('\n'), remainder].filter((part) => part.trim() !== '').join('\n\n').trim();
    }
  }

  return { title: scanned.other.join(' ').trim(), facts, rest };
}

/* ------------------------------------------------------------ hot job alert */

export interface HotJobInput {
  job: NotifyJobView;
  match: NotifyMatchView;
  profile?: NotifyProfileView | null;
  dashboardUrl?: string;
}

function jobDashboardUrl(jobId: string): string {
  return publicUrl(`/#/jobs/${encodeURIComponent(jobId)}`);
}

export function buildHotJobAlert(input: HotJobInput): NotificationMessage {
  const { job, match, profile } = input;
  const score = num(match.score) ?? 0;

  const facts: MessageFact[] = [
    { label: 'Score', value: `${scoreBar(score)}/100` },
    { label: 'Budget', value: formatBudget(job) },
    { label: 'Client', value: formatClient(job) },
    { label: 'Competition', value: formatCompetition(job) },
    { label: 'Posted', value: formatPosted(job) },
  ];

  if (profile?.name) facts.push({ label: 'Profile', value: profile.name });
  if (match.decision) facts.push({ label: 'Decision', value: String(match.decision) });

  const skills = (match.matchedSkills ?? []).map(oneLine).filter(Boolean).slice(0, 5);
  if (skills.length > 0) facts.push({ label: 'Skills', value: skills.join(', ') });

  const reasons = formatReasons(match.reasons);
  if (reasons) facts.push({ label: 'Reasons', value: reasons });

  const redFlags = formatRedFlags(match.redFlags);
  if (redFlags) facts.push({ label: 'Red flags', value: redFlags });

  const dashboardUrl = input.dashboardUrl ?? jobDashboardUrl(job.id);
  const actions: NotificationAction[] = [
    { label: 'Open job', url: job.url },
    { label: 'Dashboard', url: dashboardUrl },
  ];

  const urgent = String(match.decision ?? '').toUpperCase() === 'BID' || score >= 85;

  return {
    subject: truncate(`Hot job ${Math.round(score)}/100: ${oneLine(job.title)}`, SUBJECT_MAX),
    body: renderBody(oneLine(job.title), facts),
    url: job.url,
    actions,
    refType: 'job',
    refId: job.id,
    urgent,
  };
}

/* ------------------------------------------------------- approval request */

export interface ApprovalRequestInput {
  job: NotifyJobView;
  proposal: NotifyProposalView;
  profile: NotifyProfileView;
  match?: NotifyMatchView | null;
  previewChars?: number;
  /** Overrides the signed links; used by tests and by callers with their own routing. */
  approveUrl?: string;
  rejectUrl?: string;
}

function describeBid(
  job: NotifyJobView,
  proposal: NotifyProposalView,
  profile: NotifyProfileView,
): string {
  const currency = job.currency ?? 'USD';
  const rate = num(proposal.hourlyRate) ?? num(profile.hourlyRate);
  if (String(job.jobType ?? '').toUpperCase() === 'HOURLY') {
    return rate === null ? 'rate not set' : `${formatMoney(rate, currency)}/hr`;
  }
  const bid = num(proposal.bidAmount);
  if (bid !== null) return formatMoney(bid, currency);
  return rate === null ? 'not set' : `${formatMoney(rate, currency)}/hr`;
}

export function buildApprovalRequest(input: ApprovalRequestInput): NotificationMessage {
  const { job, proposal, profile, match } = input;
  const score = num(match?.score);
  const previewChars = input.previewChars ?? COVER_LETTER_PREVIEW_CHARS;

  const facts: MessageFact[] = [
    { label: 'Score', value: score === null ? 'unscored' : `${scoreBar(score)}/100` },
    { label: 'Bid', value: describeBid(job, proposal, profile) },
    { label: 'Budget', value: formatBudget(job) },
    { label: 'Client', value: formatClient(job) },
    { label: 'Competition', value: formatCompetition(job) },
    { label: 'Posted', value: formatPosted(job) },
    { label: 'Profile', value: profile.name },
  ];

  const connects = num(proposal.connectsCost) ?? num(job.connectsRequired);
  if (connects !== null) facts.push({ label: 'Connects', value: String(connects) });
  if (proposal.estimatedDurationLabel) {
    facts.push({ label: 'Duration', value: oneLine(proposal.estimatedDurationLabel) });
  }

  const redFlags = formatRedFlags(match?.redFlags);
  if (redFlags) facts.push({ label: 'Red flags', value: redFlags });

  const approveUrl = input.approveUrl ?? buildActionUrl(proposal.id, 'approve');
  const rejectUrl = input.rejectUrl ?? buildActionUrl(proposal.id, 'reject');

  const actions: NotificationAction[] = [
    { label: 'Approve', url: approveUrl },
    { label: 'Reject', url: rejectUrl },
    { label: 'Open job', url: job.url },
  ];

  const preview = truncate(proposal.coverLetter ?? '', previewChars);
  const scoreLabel = score === null ? 'unscored' : `${Math.round(score)}/100`;

  return {
    subject: truncate(`Approve proposal (${scoreLabel}): ${oneLine(job.title)}`, SUBJECT_MAX),
    body: renderBody(oneLine(job.title), facts, [preview]),
    url: buildProposalUrl(proposal.id),
    actions,
    refType: 'proposal',
    refId: proposal.id,
    urgent: true,
  };
}

/* ------------------------------------------------------ submitted receipt */

export interface SubmittedInput {
  job: NotifyJobView;
  proposal: NotifyProposalView;
  profile: NotifyProfileView;
  submitter: string;
  status: string;
  message?: string | null;
  connectsSpent?: number | null;
  externalRef?: string | null;
  dryRun?: boolean;
}

export function buildSubmittedConfirmation(input: SubmittedInput): NotificationMessage {
  const { job, proposal, profile } = input;
  const status = String(input.status ?? 'SUBMITTED').toUpperCase();
  const dryRun = input.dryRun === true || status === 'DRY_RUN';

  const facts: MessageFact[] = [
    { label: 'Status', value: dryRun ? 'DRY RUN (nothing was sent)' : status },
    { label: 'Submitter', value: input.submitter },
    { label: 'Bid', value: describeBid(job, proposal, profile) },
    { label: 'Profile', value: profile.name },
  ];

  const connects = num(input.connectsSpent);
  if (connects !== null) facts.push({ label: 'Connects', value: String(connects) });
  if (input.externalRef) facts.push({ label: 'Ref', value: oneLine(input.externalRef) });

  const sections = input.message ? [oneLine(input.message)] : [];
  const verb = dryRun ? 'Dry run' : 'Submitted';

  return {
    subject: truncate(`${verb}: ${oneLine(job.title)}`, SUBJECT_MAX),
    body: renderBody(oneLine(job.title), facts, sections),
    url: job.url,
    actions: [
      { label: 'Open job', url: job.url },
      { label: 'Dashboard', url: buildProposalUrl(proposal.id) },
    ],
    refType: 'proposal',
    refId: proposal.id,
    urgent: false,
  };
}

/* ------------------------------------------------------------ daily digest */

export interface DigestHighlight {
  title: string;
  score?: number | null;
  url?: string | null;
  status?: string | null;
}

export interface DigestInput {
  periodLabel?: string;
  stats?: Partial<PipelineStats>;
  highlights?: DigestHighlight[];
  notes?: string[];
  dashboardUrl?: string;
  maxHighlights?: number;
}

export function buildDailyDigest(input: DigestInput = {}): NotificationMessage {
  const period = input.periodLabel ?? 'last 24h';
  const stats = input.stats ?? {};
  const maxHighlights = input.maxHighlights ?? 8;

  const facts: MessageFact[] = [{ label: 'Period', value: period }];
  const push = (label: string, value: number | null | undefined): void => {
    const parsed = num(value);
    if (parsed !== null) facts.push({ label, value: String(Math.round(parsed)) });
  };
  push('Seen', stats.jobsSeen24h);
  push('Scored', stats.jobsScored24h);
  push('Drafted', stats.proposalsDrafted24h);
  push('Submitted', stats.submitted24h);
  push('Pending', stats.pendingApproval);
  const avg = num(stats.avgScore24h);
  if (avg !== null) facts.push({ label: 'Avg score', value: avg.toFixed(1) });

  const highlights = (input.highlights ?? []).slice(0, maxHighlights);
  const sections: string[] = [];
  if (highlights.length > 0) {
    sections.push(
      highlights
        .map((item) => {
          const score = num(item.score);
          const prefix = score === null ? '-' : `${Math.round(score)}`;
          const status = item.status ? ` [${oneLine(item.status)}]` : '';
          const url = item.url ? `\n  ${item.url}` : '';
          return `${prefix} ${truncate(oneLine(item.title), 90)}${status}${url}`;
        })
        .join('\n'),
    );
  }
  const notes = (input.notes ?? []).map(oneLine).filter(Boolean);
  if (notes.length > 0) sections.push(notes.join('\n'));

  const dashboardUrl = input.dashboardUrl ?? publicUrl('/');
  const headline = [
    num(stats.jobsSeen24h) === null ? null : `${Math.round(stats.jobsSeen24h ?? 0)} seen`,
    num(stats.proposalsDrafted24h) === null
      ? null
      : `${Math.round(stats.proposalsDrafted24h ?? 0)} drafted`,
    num(stats.pendingApproval) === null
      ? null
      : `${Math.round(stats.pendingApproval ?? 0)} pending`,
  ]
    .filter((part): part is string => part !== null)
    .join(', ');

  return {
    subject: truncate(
      headline === '' ? `UpBid digest (${period})` : `UpBid digest (${period}): ${headline}`,
      SUBJECT_MAX,
    ),
    body: renderBody(`UpBid digest`, facts, sections),
    url: dashboardUrl,
    actions: [{ label: 'Dashboard', url: dashboardUrl }],
    refType: 'digest',
    refId: period,
    urgent: false,
  };
}

/* ------------------------------------------------------------ system alert */

export type SystemAlertKind =
  | 'WORKER_DOWN'
  | 'SOURCE_FAILING'
  | 'QUOTA_EXHAUSTED'
  | 'DEGRADED'
  | 'RECOVERED';

export type SystemAlertSeverity = 'INFO' | 'WARN' | 'CRITICAL';

export interface SystemAlertInput {
  kind: SystemAlertKind | string;
  component: string;
  detail: string;
  severity?: SystemAlertSeverity;
  facts?: MessageFact[];
  dashboardUrl?: string;
  refId?: string;
}

const KIND_TITLES: Record<string, string> = {
  WORKER_DOWN: 'Worker is not beating',
  SOURCE_FAILING: 'Source keeps failing',
  QUOTA_EXHAUSTED: 'Quota exhausted',
  DEGRADED: 'Service degraded',
  RECOVERED: 'Recovered',
};

export function buildSystemAlert(input: SystemAlertInput): NotificationMessage {
  const severity = input.severity ?? 'WARN';
  const kind = String(input.kind).toUpperCase();
  const title = KIND_TITLES[kind] ?? oneLine(String(input.kind));

  const facts: MessageFact[] = [
    { label: 'Component', value: oneLine(input.component) },
    { label: 'Severity', value: severity },
    { label: 'Kind', value: kind },
    ...(input.facts ?? []),
  ];

  const dashboardUrl = input.dashboardUrl ?? publicUrl('/#/health');

  return {
    subject: truncate(`[${severity}] ${title}: ${oneLine(input.component)}`, SUBJECT_MAX),
    body: renderBody(title, facts, [oneLine(input.detail)]),
    url: dashboardUrl,
    actions: [{ label: 'Open dashboard', url: dashboardUrl }],
    refType: 'system',
    refId: input.refId ?? input.component,
    urgent: severity === 'CRITICAL',
  };
}

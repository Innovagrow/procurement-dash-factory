/**
 * Slack channel. Posts Block Kit to an incoming webhook: a header, the message
 * facts as fields, the free-text body as a section, and the message actions as
 * url buttons.
 */

import { env } from '../config/env';
import { ConfigError } from '../lib/errors';
import { requestWithRetry } from '../lib/http';
import { child } from '../lib/logger';
import type { NotificationChannel, NotificationMessage } from '../types';
import { parseMessageFacts, truncate } from './format';

const log = child('notify:slack');

export const CHANNEL_NAME = 'slack';

/** Block Kit limits. */
const MAX_HEADER_CHARS = 150;
const MAX_SECTION_CHARS = 2900;
const MAX_FIELD_CHARS = 1800;
const MAX_FIELDS = 10;
const MAX_BUTTONS = 5;
const MAX_BUTTON_LABEL = 75;
const MAX_FALLBACK_CHARS = 3000;

export interface SlackTextObject {
  type: 'plain_text' | 'mrkdwn';
  text: string;
  emoji?: boolean;
}

export interface SlackButtonElement {
  type: 'button';
  text: SlackTextObject;
  url: string;
  action_id: string;
  style?: 'primary' | 'danger';
}

export interface SlackBlock {
  type: 'header' | 'section' | 'actions' | 'context' | 'divider';
  text?: SlackTextObject;
  fields?: SlackTextObject[];
  elements?: (SlackButtonElement | SlackTextObject)[];
  block_id?: string;
}

export interface SlackPayload {
  /** Plain-text fallback: this is what the mobile push banner shows. */
  text: string;
  blocks: SlackBlock[];
}

/** Slack mrkdwn only reserves these three. */
export function escapeSlack(text: string): string {
  return (text ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\/\S+$/i.test(url.trim());
}

function slugify(label: string, index: number): string {
  const base = label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
  return `upbid_${base === '' ? 'action' : base}_${index}`;
}

function buttonStyle(label: string): 'primary' | 'danger' | undefined {
  const normalized = label.trim().toLowerCase();
  if (normalized.startsWith('approve')) return 'primary';
  if (normalized.startsWith('reject') || normalized.startsWith('skip')) return 'danger';
  return undefined;
}

export function buildSlackPayload(msg: NotificationMessage): SlackPayload {
  const subject = (msg.subject ?? '').trim() || 'UpBid notification';
  const parsed = parseMessageFacts(msg.body ?? '');
  const blocks: SlackBlock[] = [];

  blocks.push({
    type: 'header',
    text: { type: 'plain_text', text: truncate(subject, MAX_HEADER_CHARS), emoji: true },
  });

  // Only worth its own block when it heads structured content; an unstructured
  // body is rendered whole further down and would otherwise be duplicated.
  const hasStructure = parsed.facts.length > 0 || parsed.rest !== '';
  if (hasStructure && parsed.title !== '' && parsed.title !== subject) {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: `*${escapeSlack(truncate(parsed.title, 300))}*` },
    });
  }

  const fields = parsed.facts.slice(0, MAX_FIELDS).map<SlackTextObject>((fact) => ({
    type: 'mrkdwn',
    text: truncate(`*${escapeSlack(fact.label)}*\n${escapeSlack(fact.value)}`, MAX_FIELD_CHARS),
  }));
  if (fields.length > 0) blocks.push({ type: 'section', fields });

  // Falls back to the whole body when the message did not come from format.ts.
  const detail = hasStructure ? parsed.rest : msg.body ?? '';
  if (detail.trim() !== '') {
    blocks.push({
      type: 'section',
      text: { type: 'mrkdwn', text: truncate(escapeSlack(detail), MAX_SECTION_CHARS) },
    });
  }

  const buttons: SlackButtonElement[] = [];
  const seen = new Set<string>();
  for (const action of msg.actions ?? []) {
    const url = (action?.url ?? '').trim();
    const label = (action?.label ?? '').trim();
    if (label === '' || !isHttpUrl(url) || seen.has(url)) continue;
    seen.add(url);
    const style = buttonStyle(label);
    const button: SlackButtonElement = {
      type: 'button',
      text: { type: 'plain_text', text: truncate(label, MAX_BUTTON_LABEL), emoji: true },
      url,
      action_id: slugify(label, buttons.length),
    };
    if (style) button.style = style;
    buttons.push(button);
    if (buttons.length >= MAX_BUTTONS) break;
  }

  const messageUrl = (msg.url ?? '').trim();
  if (buttons.length < MAX_BUTTONS && isHttpUrl(messageUrl) && !seen.has(messageUrl)) {
    buttons.push({
      type: 'button',
      text: { type: 'plain_text', text: 'View job', emoji: true },
      url: messageUrl,
      action_id: slugify('view_job', buttons.length),
    });
  }
  if (buttons.length > 0) blocks.push({ type: 'actions', elements: buttons });

  const contextParts: string[] = [];
  if (msg.refType) contextParts.push(`${msg.refType}${msg.refId ? ` ${msg.refId}` : ''}`);
  if (msg.urgent) contextParts.push('urgent');
  contextParts.push(new Date().toISOString());
  blocks.push({
    type: 'context',
    elements: [{ type: 'mrkdwn', text: escapeSlack(contextParts.join('  |  ')) }],
  });

  return { text: truncate(subject, MAX_FALLBACK_CHARS), blocks };
}

export class SlackChannel implements NotificationChannel {
  readonly name = CHANNEL_NAME;

  isConfigured(): boolean {
    return Boolean(env.SLACK_WEBHOOK_URL);
  }

  /** Host only: the webhook URL itself is a secret. */
  describeTarget(): string | null {
    const url = env.SLACK_WEBHOOK_URL;
    if (!url) return null;
    try {
      return new URL(url).host;
    } catch {
      return 'slack-webhook';
    }
  }

  async send(msg: NotificationMessage): Promise<void> {
    const webhookUrl = env.SLACK_WEBHOOK_URL;
    if (!webhookUrl) throw new ConfigError('SLACK_WEBHOOK_URL is not set');

    const payload = buildSlackPayload(msg);

    await requestWithRetry(
      {
        url: webhookUrl,
        method: 'POST',
        data: payload,
        headers: { 'Content-Type': 'application/json' },
      },
      { label: 'slack webhook', maxRetries: env.HTTP_MAX_RETRIES },
    );

    log.debug(
      { refType: msg.refType, refId: msg.refId, blocks: payload.blocks.length },
      'slack notification sent',
    );
  }
}

export const slackChannel = new SlackChannel();

export default slackChannel;

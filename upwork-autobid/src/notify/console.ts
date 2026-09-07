/**
 * Fallback channel. Always configured, never fails: when no phone channel is set
 * up the operator still sees the full alert - links included - in the process log.
 */

import { child } from '../lib/logger';
import type { NotificationChannel, NotificationMessage } from '../types';
import { truncate } from './format';

const log = child('notify:console');

export const CHANNEL_NAME = 'console';

const RULE = '-'.repeat(64);
const MAX_BODY_CHARS = 4000;

/** Renders the message as one indented block so it survives log aggregation. */
export function renderConsoleBlock(msg: NotificationMessage): string {
  const subject = (msg.subject ?? '').trim() || 'UpBid notification';
  const lines: string[] = [RULE, subject, RULE];

  const body = truncate(msg.body ?? '', MAX_BODY_CHARS);
  if (body !== '') {
    for (const line of body.split('\n')) lines.push(`  ${line}`);
  }

  const actions = (msg.actions ?? []).filter((action) => action?.label && action?.url);
  if (actions.length > 0) {
    lines.push('');
    for (const action of actions) lines.push(`  ${action.label} -> ${action.url}`);
  }

  if (msg.url) lines.push(`  Open -> ${msg.url}`);
  lines.push(RULE);

  return lines.join('\n');
}

export class ConsoleChannel implements NotificationChannel {
  readonly name = CHANNEL_NAME;

  isConfigured(): boolean {
    return true;
  }

  describeTarget(): string | null {
    return 'stdout';
  }

  async send(msg: NotificationMessage): Promise<void> {
    const block = renderConsoleBlock(msg);
    const bindings = {
      refType: msg.refType ?? null,
      refId: msg.refId ?? null,
      urgent: msg.urgent === true,
    };
    if (msg.urgent === true) log.warn(bindings, block);
    else log.info(bindings, block);
  }
}

export const consoleChannel = new ConsoleChannel();

export default consoleChannel;

/** Date/duration helpers. Every bucket key is UTC so quotas do not shift with host TZ. */

export const SECOND_MS = 1000;
export const MINUTE_MS = 60 * SECOND_MS;
export const HOUR_MS = 60 * MINUTE_MS;
export const DAY_MS = 24 * HOUR_MS;

export function now(): Date {
  return new Date();
}

export function minutesSince(date: Date | string | null | undefined, reference: Date = new Date()): number {
  if (!date) return Number.POSITIVE_INFINITY;
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return Number.POSITIVE_INFINITY;
  return (reference.getTime() - value.getTime()) / MINUTE_MS;
}

export function secondsSince(date: Date | string | null | undefined, reference: Date = new Date()): number {
  return minutesSince(date, reference) * 60;
}

export function minutesAgo(minutes: number, reference: Date = new Date()): Date {
  return new Date(reference.getTime() - minutes * MINUTE_MS);
}

export function hoursAgo(hours: number, reference: Date = new Date()): Date {
  return new Date(reference.getTime() - hours * HOUR_MS);
}

export function daysAgo(days: number, reference: Date = new Date()): Date {
  return new Date(reference.getTime() - days * DAY_MS);
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * MINUTE_MS);
}

export function isOlderThanMinutes(date: Date | null | undefined, minutes: number): boolean {
  if (!date) return false;
  return minutesSince(date) > minutes;
}

const pad = (value: number, width = 2): string => String(value).padStart(width, '0');

/** "2026-09-07" in UTC - the key for daily quota counters. */
export function dayBucket(date: Date = new Date()): string {
  return `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;
}

/** "2026-09-07T14" in UTC - the key for hourly quota counters. */
export function hourBucket(date: Date = new Date()): string {
  return `${dayBucket(date)}T${pad(date.getUTCHours())}`;
}

/** Seconds left in the current UTC day; the TTL for a dayBucket counter. */
export function secondsUntilEndOfDay(date: Date = new Date()): number {
  const end = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1, 0, 0, 0, 0);
  return Math.max(1, Math.ceil((end - date.getTime()) / SECOND_MS));
}

/** Seconds left in the current UTC hour; the TTL for an hourBucket counter. */
export function secondsUntilEndOfHour(date: Date = new Date()): number {
  const end = Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    date.getUTCHours() + 1,
  );
  return Math.max(1, Math.ceil((end - date.getTime()) / SECOND_MS));
}

/** Quota counter key, e.g. "submissions:day:<profileId>:2026-09-07". */
export function quotaKey(scope: string, profileId: string, bucket: string): string {
  return `${scope}:${profileId}:${bucket}`;
}

export function humanizeAge(date: Date | string | null | undefined, reference: Date = new Date()): string {
  if (!date) return 'unknown';
  const value = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(value.getTime())) return 'unknown';

  const deltaMs = reference.getTime() - value.getTime();
  if (deltaMs < 0) return 'just now';

  const seconds = Math.floor(deltaMs / SECOND_MS);
  if (seconds < 60) return seconds <= 1 ? 'just now' : `${seconds}s ago`;

  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;

  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;

  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;

  return `${Math.floor(months / 12)}y ago`;
}

export function humanizeDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return '0s';
  const seconds = Math.floor(ms / SECOND_MS);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${minutes % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

const RELATIVE_UNIT_MS: Record<string, number> = {
  second: SECOND_MS,
  seconds: SECOND_MS,
  sec: SECOND_MS,
  secs: SECOND_MS,
  minute: MINUTE_MS,
  minutes: MINUTE_MS,
  min: MINUTE_MS,
  mins: MINUTE_MS,
  hour: HOUR_MS,
  hours: HOUR_MS,
  hr: HOUR_MS,
  hrs: HOUR_MS,
  day: DAY_MS,
  days: DAY_MS,
  week: 7 * DAY_MS,
  weeks: 7 * DAY_MS,
  month: 30 * DAY_MS,
  months: 30 * DAY_MS,
  year: 365 * DAY_MS,
  years: 365 * DAY_MS,
};

/**
 * Parses the timestamps Upwork renders in RSS titles and email digests:
 * "2 minutes ago", "an hour ago", "yesterday", "just now", or an ISO string.
 * Returns null when the input cannot be understood, so callers can fall back
 * to firstSeenAt rather than storing a wrong postedAt.
 */
export function parseRelativeUpworkTime(
  input: string | null | undefined,
  reference: Date = new Date(),
): Date | null {
  if (!input) return null;

  const text = String(input).trim();
  if (text === '') return null;

  const normalized = text.toLowerCase();

  if (normalized === 'just now' || normalized === 'now' || normalized === 'moments ago') {
    return new Date(reference.getTime());
  }
  if (normalized === 'today') return new Date(reference.getTime());
  if (normalized === 'yesterday') return new Date(reference.getTime() - DAY_MS);

  // "2 minutes ago", "a minute ago", "an hour ago", "3 days ago"
  const relative = normalized.match(
    /^(?:about\s+)?(\d+|a|an|one|two|three|four|five|six|seven|eight|nine|ten)\s+([a-z]+)\s+ago$/,
  );
  if (relative) {
    const [, rawAmount = '', rawUnit = ''] = relative;
    const amount = parseAmount(rawAmount);
    const unitMs = RELATIVE_UNIT_MS[rawUnit];
    if (amount !== null && unitMs !== undefined) {
      return new Date(reference.getTime() - amount * unitMs);
    }
    return null;
  }

  // "last week", "last month"
  const last = normalized.match(/^last\s+([a-z]+)$/);
  if (last) {
    const unitMs = RELATIVE_UNIT_MS[last[1] ?? ''];
    if (unitMs !== undefined) return new Date(reference.getTime() - unitMs);
    return null;
  }

  const parsed = Date.parse(text);
  if (!Number.isNaN(parsed)) return new Date(parsed);

  return null;
}

const WORD_NUMBERS: Record<string, number> = {
  a: 1,
  an: 1,
  one: 1,
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
};

function parseAmount(raw: string): number | null {
  if (/^\d+$/.test(raw)) {
    const value = Number(raw);
    return Number.isFinite(value) ? value : null;
  }
  return WORD_NUMBERS[raw] ?? null;
}

/** ISO string with millisecond precision, or null. Safe for JSON responses. */
export function toIso(date: Date | null | undefined): string | null {
  if (!date) return null;
  const value = date instanceof Date ? date : new Date(date);
  return Number.isNaN(value.getTime()) ? null : value.toISOString();
}

/** Clamps a poll interval into a sane range and returns milliseconds. */
export function intervalMs(seconds: number, min = 5, max = 86400): number {
  const clamped = Math.min(max, Math.max(min, Math.floor(seconds)));
  return clamped * SECOND_MS;
}

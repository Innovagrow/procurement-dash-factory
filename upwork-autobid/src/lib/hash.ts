import { createHash, createHmac, randomUUID } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function sha256Short(input: string, length = 16): string {
  return sha256(input).slice(0, length);
}

/**
 * JSON.stringify with deterministic key ordering, so two structurally equal
 * objects always serialise to the same string regardless of insertion order.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return typeof value === 'number' && !Number.isFinite(value) ? null : value;
  }
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map(sortValue);

  const source = value as Record<string, unknown>;
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(source).sort()) {
    const entry = source[key];
    if (entry === undefined) continue;
    sorted[key] = sortValue(entry);
  }
  return sorted;
}

export interface HashableJob {
  title?: string | null;
  description?: string | null;
  budgetAmount?: number | null;
  hourlyMin?: number | null;
  hourlyMax?: number | null;
  jobType?: string | null;
  skills?: string[] | null;
  screeningQuestions?: string[] | null;
}

function normalizeText(value: string | null | undefined): string {
  return (value ?? '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/**
 * Stable content fingerprint for a job. Two fetches of the same unchanged
 * posting produce the same hash, so re-crawls are cheap no-ops; an edited
 * budget or description produces a new hash and triggers a re-score.
 * Deliberately excludes volatile counters (proposalsCount, interviewingCount).
 */
export function hashJobContent(raw: HashableJob): string {
  const canonical = {
    title: normalizeText(raw.title),
    description: normalizeText(raw.description),
    jobType: normalizeText(raw.jobType),
    budgetAmount: raw.budgetAmount ?? null,
    hourlyMin: raw.hourlyMin ?? null,
    hourlyMax: raw.hourlyMax ?? null,
    skills: [...(raw.skills ?? [])].map(normalizeText).filter(Boolean).sort(),
    screeningQuestions: [...(raw.screeningQuestions ?? [])].map(normalizeText).filter(Boolean),
  };
  return sha256(stableStringify(canonical));
}

/** Deterministic id for a (source, externalId) pair - useful as an idempotency key. */
export function jobKey(source: string, externalId: string): string {
  return sha256Short(`${source}::${externalId}`, 24);
}

/** Random, collision-resistant id for jobs, locks and correlation ids. */
export function shortId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 12);
}

export function uuid(): string {
  return randomUUID();
}

/** Constant-time string comparison for API keys and webhook signatures. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i += 1) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

/** HMAC-SHA256 signature used by the webhook submitter (hex encoded). */
export function signPayload(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Verifies a signature produced by signPayload without leaking timing. */
export function verifySignature(payload: string, secret: string, signature: string): boolean {
  return safeEqual(signPayload(payload, secret), signature.trim().toLowerCase());
}

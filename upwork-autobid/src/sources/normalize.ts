/**
 * Normalisation layer. Every source funnels its upstream payload through here,
 * so the rest of the pipeline only ever sees a validated RawJob with consistent
 * currencies, job types, skill casing and canonical Upwork URLs.
 */

import { z } from 'zod';
import { ValidationError } from '../lib/errors';
import { hashJobContent } from '../lib/hash';
import { child } from '../lib/logger';
import { parseRelativeUpworkTime } from '../lib/time';
import { emptyClientInfo, type ClientInfo, type JobType, type RawJob } from '../types';

const log = child('sources:normalize');

export const DEFAULT_CURRENCY = 'USD';
export const UPWORK_JOB_BASE = 'https://www.upwork.com/jobs/';

/* ------------------------------------------------------------ tiny pickers */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

/** Reads a dotted path ("client.location.country") without throwing on gaps. */
export function pickPath(source: unknown, path: string): unknown {
  let current: unknown = source;
  for (const segment of path.split('.')) {
    if (Array.isArray(current)) {
      const index = Number(segment);
      current = Number.isInteger(index) ? current[index] : undefined;
      continue;
    }
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[segment];
  }
  return current;
}

/** First path that yields a usable string. Upstream schemas vary by API tier. */
export function pickString(source: unknown, ...paths: string[]): string | null {
  for (const path of paths) {
    const value = toStringOrNull(pickPath(source, path));
    if (value !== null) return value;
  }
  return null;
}

export function pickNumber(source: unknown, ...paths: string[]): number | null {
  for (const path of paths) {
    const value = toNumberOrNull(pickPath(source, path));
    if (value !== null) return value;
  }
  return null;
}

export function pickInt(source: unknown, ...paths: string[]): number | null {
  const value = pickNumber(source, ...paths);
  return value === null ? null : Math.round(value);
}

export function pickBoolean(source: unknown, ...paths: string[]): boolean | null {
  for (const path of paths) {
    const value = toBooleanOrNull(pickPath(source, path));
    if (value !== null) return value;
  }
  return null;
}

export function pickArray(source: unknown, ...paths: string[]): unknown[] {
  for (const path of paths) {
    const value = pickPath(source, path);
    if (Array.isArray(value)) return value;
  }
  return [];
}

export function pickDate(source: unknown, ...paths: string[]): Date | null {
  for (const path of paths) {
    const value = toDateOrNull(pickPath(source, path));
    if (value !== null) return value;
  }
  return null;
}

export function firstDefined(...values: unknown[]): unknown {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return undefined;
}

/* --------------------------------------------------------------- coercions */

export function toStringOrNull(value: unknown): string | null {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' ? null : trimmed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value === 'boolean') return String(value);
  return null;
}

export function toNumberOrNull(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return parseMoney(value);
  const record = asRecord(value);
  if (record) {
    // Upwork money scalars arrive as { rawValue, currency, displayValue }.
    const inner = firstDefined(record.rawValue, record.amount, record.value, record.displayValue);
    if (inner !== undefined) return toNumberOrNull(inner);
  }
  return null;
}

export function toBooleanOrNull(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'verified', 'payment method verified'].includes(normalized)) return true;
    if (['false', '0', 'no', 'n', 'none', 'unverified', 'not verified'].includes(normalized)) return false;
  }
  return null;
}

export function toDateOrNull(value: unknown): Date | null {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Heuristic: 10-digit values are seconds, 13-digit values are milliseconds.
    const ms = value < 1e12 ? value * 1000 : value;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value === 'string') return parseRelativeUpworkTime(value);
  return null;
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}

export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/* ------------------------------------------------------------------- text */

const NAMED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  hellip: '…',
  mdash: '—',
  ndash: '–',
  rsquo: '’',
  lsquo: '‘',
  ldquo: '“',
  rdquo: '”',
  middot: '·',
  bull: '•',
  trade: '™',
  copy: '©',
  reg: '®',
  deg: '°',
  euro: '€',
  pound: '£',
  yen: '¥',
  cent: '¢',
  tilde: '~',
};

export function decodeEntities(input: string): string {
  return input.replace(/&(#[xX]?[0-9a-fA-F]+|[a-zA-Z][a-zA-Z0-9]{1,10});/g, (match, entity: string) => {
    if (entity.startsWith('#')) {
      const isHex = entity[1] === 'x' || entity[1] === 'X';
      const digits = isHex ? entity.slice(2) : entity.slice(1);
      const code = Number.parseInt(digits, isHex ? 16 : 10);
      if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) return match;
      try {
        return String.fromCodePoint(code);
      } catch {
        return match;
      }
    }
    const named = NAMED_ENTITIES[entity.toLowerCase()];
    return named === undefined ? match : named;
  });
}

/** HTML -> readable plain text. Keeps paragraph and list breaks. */
export function stripHtml(input: string): string {
  const withBreaks = input
    .replace(/<\s*(script|style)[^>]*>[\s\S]*?<\s*\/\s*\1\s*>/gi, ' ')
    .replace(/<\s*br\s*\/?\s*>/gi, '\n')
    .replace(/<\s*\/\s*(p|div|tr|h[1-6]|li|ul|ol|table)\s*>/gi, '\n')
    .replace(/<\s*li[^>]*>/gi, '\n- ')
    .replace(/<[^>]*>/g, ' ');
  return collapseWhitespace(decodeEntities(withBreaks));
}

/** Collapses runs of spaces and blank lines without destroying line structure. */
export function collapseWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u00a0\u2007\u202f]/g, ' ')
    .split('\n')
    .map((line) => line.replace(/[ \t]+/g, ' ').trim())
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/* ------------------------------------------------------------------ money */

/**
 * Parses "$1,500.00", "1500", "50,00 EUR", "USD 30.5" and Upwork money objects.
 * Returns null rather than 0 when nothing numeric is present, so "no budget"
 * stays distinguishable from "budget of zero".
 */
export function parseMoney(input: unknown): number | null {
  if (typeof input === 'number') return Number.isFinite(input) ? round2(input) : null;
  if (input !== null && typeof input === 'object') {
    const record = asRecord(input);
    if (!record) return null;
    const inner = firstDefined(record.rawValue, record.amount, record.value, record.displayValue);
    return inner === undefined ? null : parseMoney(inner);
  }
  if (typeof input !== 'string') return null;

  const text = decodeEntities(input);
  const match = text.match(/-?\d[\d.,\s]*/);
  if (!match) return null;

  let digits = match[0].replace(/\s/g, '');
  const hasComma = digits.includes(',');
  const hasDot = digits.includes('.');

  if (hasComma && hasDot) {
    // Whichever separator comes last is the decimal point.
    if (digits.lastIndexOf(',') > digits.lastIndexOf('.')) {
      digits = digits.replace(/\./g, '').replace(',', '.');
    } else {
      digits = digits.replace(/,/g, '');
    }
  } else if (hasComma) {
    digits = /^-?\d{1,3}(,\d{3})+$/.test(digits)
      ? digits.replace(/,/g, '')
      : digits.replace(',', '.');
  }

  digits = digits.replace(/[,.]$/, '');
  const value = Number(digits);
  return Number.isFinite(value) ? round2(value) : null;
}

export interface HourlyRange {
  min: number | null;
  max: number | null;
}

/** Parses "$30.00-$50.00", "30 to 50", "$45.00/hr" and "Hourly: $20-$25". */
export function parseHourlyRange(input: unknown): HourlyRange {
  const text = toStringOrNull(input);
  if (text === null) return { min: null, max: null };

  const normalized = decodeEntities(text).replace(/\s+/g, ' ');
  const range = normalized.match(
    /([$€£¥]?\s?-?[\d.,]+)\s*(?:-|–|—|to|…)\s*([$€£¥]?\s?[\d.,]+)/i,
  );

  if (range) {
    const first = parseMoney(range[1]);
    const second = parseMoney(range[2]);
    if (first !== null && second !== null) {
      return first <= second ? { min: first, max: second } : { min: second, max: first };
    }
    if (first !== null) return { min: first, max: null };
    if (second !== null) return { min: null, max: second };
    return { min: null, max: null };
  }

  const single = parseMoney(normalized);
  if (single === null) return { min: null, max: null };
  return { min: single, max: single };
}

/* -------------------------------------------------------------- job types */

const HOURLY_HINTS = ['hourly', 'per hour', '/hr', 'hour_rate', 'hourly_rate'];
const FIXED_HINTS = ['fixed', 'fixed-price', 'fixed_price', 'fixed price', 'budget', 'milestone'];

export function inferJobType(
  explicit: unknown,
  hints: { hourlyMin?: number | null; hourlyMax?: number | null; budgetAmount?: number | null } = {},
): JobType {
  const text = toStringOrNull(explicit);
  if (text !== null) {
    const normalized = text.toLowerCase();
    if (normalized === 'hourly' || HOURLY_HINTS.some((hint) => normalized.includes(hint))) return 'HOURLY';
    if (normalized === 'fixed' || FIXED_HINTS.some((hint) => normalized.includes(hint))) return 'FIXED';
  }
  if ((hints.hourlyMin ?? null) !== null || (hints.hourlyMax ?? null) !== null) return 'HOURLY';
  if ((hints.budgetAmount ?? null) !== null) return 'FIXED';
  return 'UNKNOWN';
}

const EXPERIENCE_MAP: Record<string, string> = {
  entry: 'ENTRY',
  entry_level: 'ENTRY',
  'entry level': 'ENTRY',
  beginner: 'ENTRY',
  '1': 'ENTRY',
  intermediate: 'INTERMEDIATE',
  mid: 'INTERMEDIATE',
  '2': 'INTERMEDIATE',
  expert: 'EXPERT',
  advanced: 'EXPERT',
  '3': 'EXPERT',
};

/** Maps the many spellings Upwork uses onto ENTRY/INTERMEDIATE/EXPERT. */
export function normalizeExperienceLevel(value: unknown): string | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  const key = text.trim().toLowerCase().replace(/\s+/g, ' ');
  return EXPERIENCE_MAP[key] ?? EXPERIENCE_MAP[key.replace(/ /g, '_')] ?? text;
}

/* ----------------------------------------------------------------- skills */

/**
 * Accepts ["react"], [{name}], [{prettyName}], [{prefLabel}] or "react, node".
 * De-duplicates case-insensitively while keeping the first display casing.
 */
export function cleanSkills(input: unknown, limit = 60): string[] {
  const candidates: unknown[] = Array.isArray(input)
    ? input
    : typeof input === 'string'
      ? input.split(/[,;|]/)
      : [];

  const seen = new Set<string>();
  const output: string[] = [];

  for (const candidate of candidates) {
    let text: string | null = null;
    if (typeof candidate === 'string') {
      text = candidate;
    } else {
      const record = asRecord(candidate);
      if (record) {
        text = toStringOrNull(
          firstDefined(record.prettyName, record.prefLabel, record.name, record.label, record.skill),
        );
      }
    }
    const cleaned = toStringOrNull(text === null ? null : decodeEntities(text).replace(/\s+/g, ' '));
    if (cleaned === null || cleaned.length > 80) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
    if (output.length >= limit) break;
  }

  return output;
}

export function cleanQuestions(input: unknown, limit = 30): string[] {
  const candidates: unknown[] = Array.isArray(input) ? input : [];
  const seen = new Set<string>();
  const output: string[] = [];

  for (const candidate of candidates) {
    let text: string | null = null;
    if (typeof candidate === 'string') {
      text = candidate;
    } else {
      const record = asRecord(candidate);
      if (record) {
        text = toStringOrNull(firstDefined(record.question, record.text, record.title, record.label));
      }
    }
    if (text === null) continue;
    const cleaned = collapseWhitespace(decodeEntities(text));
    if (cleaned === '' || cleaned.length > 2000) continue;
    const key = cleaned.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    output.push(cleaned);
    if (output.length >= limit) break;
  }

  return output;
}

/* ----------------------------------------------------------------- client */

/** Coerces every client shape we have seen into ClientInfo with sane ranges. */
export function normalizeClient(input: unknown): ClientInfo {
  const info = emptyClientInfo();
  const record = asRecord(input);
  if (!record) return info;

  info.country = pickString(record, 'country', 'location.country', 'location.countryName', 'clientCountry');
  info.city = pickString(record, 'city', 'location.city', 'clientCity');
  info.companyName = pickString(record, 'companyName', 'company.name', 'clientCompanyName');
  info.clientId = pickString(
    record,
    'clientId',
    'id',
    'companyRid',
    'companyOrgUid',
    'edcUserId',
    'uid',
  );

  const verification = firstDefined(
    record.paymentVerified,
    record.isPaymentVerified,
    record.paymentVerificationStatus,
    record.verificationStatus,
    pickPath(record, 'company.paymentVerificationStatus'),
  );
  info.paymentVerified = toBooleanOrNull(verification);

  info.totalSpent = pickNumber(record, 'totalSpent', 'totalSpent.rawValue', 'totalCharges', 'clientTotalSpent');
  info.totalHires = pickInt(record, 'totalHires', 'totalAssignments', 'clientTotalHires');
  info.reviewsCount = pickInt(record, 'reviewsCount', 'totalReviews', 'totalFeedbackCount', 'clientReviewsCount');
  info.openJobs = pickInt(record, 'openJobs', 'activeJobsCount', 'totalOpenJobs');
  info.memberSince = pickDate(record, 'memberSince', 'memberSinceDate', 'creationDate', 'registrationDate');

  const rating = pickNumber(record, 'avgRating', 'totalFeedback', 'score', 'feedbackScore', 'rating');
  info.avgRating = rating === null ? null : round2(clamp(rating, 0, 5));

  const hireRate = pickNumber(record, 'hireRate', 'clientHireRate', 'hiringRate');
  if (hireRate !== null) {
    info.hireRate = round2(clamp(hireRate > 1 ? hireRate / 100 : hireRate, 0, 1));
  } else {
    const posted = pickInt(record, 'totalPostedJobs', 'totalJobsPosted', 'jobsPosted');
    if (posted !== null && posted > 0 && info.totalHires !== null) {
      info.hireRate = round2(clamp(info.totalHires / posted, 0, 1));
    }
  }

  return info;
}

/* -------------------------------------------------------------------- ids */

const CIPHERTEXT_RE = /~(0[0-9a-zA-Z]{8,})/;
const BARE_CIPHERTEXT_RE = /(?:^|[/_])(0[12][0-9a-fA-F]{12,})(?:$|[/?#])/;

export function safeDecodeUri(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

/** Pulls the Upwork job ciphertext (without the leading "~") out of any string. */
export function extractCiphertext(input: unknown): string | null {
  const text = toStringOrNull(input);
  if (text === null) return null;
  const decoded = safeDecodeUri(decodeEntities(text));

  const tilde = decoded.match(CIPHERTEXT_RE);
  if (tilde && tilde[1]) return tilde[1];

  const bare = decoded.match(BARE_CIPHERTEXT_RE);
  if (bare && bare[1]) return bare[1];

  const whole = decoded.trim().replace(/^~/, '');
  if (/^0[0-9a-zA-Z]{8,}$/.test(whole)) return whole;

  return null;
}

function stripTracking(url: string): string {
  try {
    const parsed = new URL(url);
    if (/(^|\.)upwork\.com$/i.test(parsed.hostname)) {
      parsed.search = '';
      parsed.hash = '';
      return parsed.toString().replace(/\/$/, '');
    }
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (/^utm_/i.test(key) || key === 'source' || key === 'referrer_url_path') {
        parsed.searchParams.delete(key);
      }
    }
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

/**
 * Canonical URL for a posting. Every Upwork variant (RSS link with %7E, email
 * tracking redirect, bare ciphertext) collapses to
 * https://www.upwork.com/jobs/~<ciphertext> so cross-source dedupe works.
 */
export function canonicalJobUrl(url: unknown, externalId?: string | null): string | null {
  const ciphertext = extractCiphertext(url) ?? extractCiphertext(externalId);
  if (ciphertext !== null) return `${UPWORK_JOB_BASE}~${ciphertext}`;

  const text = toStringOrNull(url);
  if (text !== null) {
    const decoded = safeDecodeUri(decodeEntities(text));
    if (/^https?:\/\//i.test(decoded)) return stripTracking(decoded);
    if (/^www\./i.test(decoded)) return stripTracking(`https://${decoded}`);
  }

  return null;
}

/** Stable external id: ciphertext when present, otherwise the given id. */
export function extractExternalId(candidates: {
  externalId?: unknown;
  url?: unknown;
  ciphertext?: unknown;
  id?: unknown;
}): string | null {
  const fromCiphertext =
    extractCiphertext(candidates.ciphertext) ??
    extractCiphertext(candidates.externalId) ??
    extractCiphertext(candidates.url) ??
    extractCiphertext(candidates.id);
  if (fromCiphertext !== null) return fromCiphertext;

  const explicit = toStringOrNull(candidates.externalId) ?? toStringOrNull(candidates.id);
  if (explicit !== null) return explicit.replace(/^~/, '').slice(0, 200);

  const url = toStringOrNull(candidates.url);
  if (url !== null) {
    const trimmed = stripTracking(safeDecodeUri(url));
    return trimmed.slice(-200);
  }

  return null;
}

/* ------------------------------------------------------------ normalisation */

export interface NormalizeInput {
  source: string;
  externalId?: unknown;
  id?: unknown;
  ciphertext?: unknown;
  url?: unknown;
  title?: unknown;
  description?: unknown;
  descriptionHtml?: unknown;
  postedAt?: unknown;
  skills?: unknown;
  category?: unknown;
  subcategory?: unknown;
  jobType?: unknown;
  budgetAmount?: unknown;
  budgetText?: unknown;
  hourlyMin?: unknown;
  hourlyMax?: unknown;
  hourlyRangeText?: unknown;
  currency?: unknown;
  durationLabel?: unknown;
  experienceLevel?: unknown;
  workload?: unknown;
  connectsRequired?: unknown;
  proposalsCount?: unknown;
  interviewingCount?: unknown;
  screeningQuestions?: unknown;
  client?: unknown;
  raw?: unknown;
}

const clientSchema = z.object({
  country: z.string().nullable(),
  city: z.string().nullable(),
  paymentVerified: z.boolean().nullable(),
  totalSpent: z.number().nullable(),
  totalHires: z.number().nullable(),
  hireRate: z.number().min(0).max(1).nullable(),
  avgRating: z.number().min(0).max(5).nullable(),
  reviewsCount: z.number().nullable(),
  memberSince: z.date().nullable(),
  openJobs: z.number().nullable(),
  clientId: z.string().nullable().optional(),
  companyName: z.string().nullable().optional(),
});

export const rawJobSchema = z.object({
  source: z.string().min(1).max(64),
  externalId: z.string().min(1).max(255),
  url: z.string().url().max(2000),
  title: z.string().min(1).max(500),
  description: z.string(),
  postedAt: z.date().nullable(),
  skills: z.array(z.string()),
  category: z.string().nullable(),
  subcategory: z.string().nullable(),
  jobType: z.enum(['HOURLY', 'FIXED', 'UNKNOWN']),
  budgetAmount: z.number().nullable(),
  hourlyMin: z.number().nullable(),
  hourlyMax: z.number().nullable(),
  currency: z.string().nullable(),
  durationLabel: z.string().nullable(),
  experienceLevel: z.string().nullable(),
  workload: z.string().nullable(),
  connectsRequired: z.number().int().nullable(),
  proposalsCount: z.number().int().nullable(),
  interviewingCount: z.number().int().nullable(),
  screeningQuestions: z.array(z.string()),
  client: clientSchema,
  raw: z.unknown().optional(),
});

const MAX_TITLE = 480;
const MAX_DESCRIPTION = 40000;

/** Builds a validated RawJob. Throws ValidationError when unusable. */
export function normalizeJob(input: NormalizeInput): RawJob {
  const source = toStringOrNull(input.source);
  if (source === null) {
    throw new ValidationError('normalizeJob: source is required');
  }

  const externalId = extractExternalId({
    externalId: input.externalId,
    url: input.url,
    ciphertext: input.ciphertext,
    id: input.id,
  });
  const url = canonicalJobUrl(input.url, externalId);

  if (externalId === null || url === null) {
    throw new ValidationError('normalizeJob: could not derive an externalId and url', {
      details: { source, url: toStringOrNull(input.url), title: toStringOrNull(input.title) },
    });
  }

  const rawTitle = toStringOrNull(input.title);
  // Titles occasionally arrive with markup (email subject lines, scraped DOM).
  const title =
    rawTitle === null ? null : stripHtml(rawTitle).replace(/\s*\n\s*/g, ' ').trim().slice(0, MAX_TITLE);
  if (title === null || title === '') {
    throw new ValidationError('normalizeJob: title is required', { details: { source, url } });
  }

  const descriptionSource =
    toStringOrNull(input.description) === null ? toStringOrNull(input.descriptionHtml) : toStringOrNull(input.description);
  const description = descriptionSource === null ? '' : stripHtml(descriptionSource).slice(0, MAX_DESCRIPTION);

  const hourlyFromText = parseHourlyRange(input.hourlyRangeText);
  const hourlyMin = toNumberOrNull(input.hourlyMin) ?? hourlyFromText.min;
  const hourlyMax = toNumberOrNull(input.hourlyMax) ?? hourlyFromText.max;
  const budgetAmount = toNumberOrNull(input.budgetAmount) ?? parseMoney(input.budgetText);

  const jobType = inferJobType(input.jobType, { hourlyMin, hourlyMax, budgetAmount });

  // Upwork sends amount 0 on hourly postings (and an empty hourly range on
  // fixed ones). Keeping the zeroes would read as "a job with a $0 budget".
  const effectiveBudget = jobType === 'HOURLY' && budgetAmount === 0 ? null : budgetAmount;
  const effectiveHourlyMin = jobType === 'FIXED' && hourlyMin === 0 ? null : hourlyMin;
  const effectiveHourlyMax = jobType === 'FIXED' && hourlyMax === 0 ? null : hourlyMax;

  const currencyRaw = toStringOrNull(input.currency);
  const currency =
    currencyRaw === null ? DEFAULT_CURRENCY : currencyRaw.toUpperCase().slice(0, 8);

  const postedAt = toDateOrNull(input.postedAt);

  const job: RawJob = {
    source,
    externalId,
    url,
    title,
    description,
    postedAt,
    skills: cleanSkills(input.skills),
    category: pickCleanString(input.category),
    subcategory: pickCleanString(input.subcategory),
    jobType,
    budgetAmount: effectiveBudget === null ? null : round2(Math.max(0, effectiveBudget)),
    hourlyMin: effectiveHourlyMin === null ? null : round2(Math.max(0, effectiveHourlyMin)),
    hourlyMax: effectiveHourlyMax === null ? null : round2(Math.max(0, effectiveHourlyMax)),
    currency,
    durationLabel: pickCleanString(input.durationLabel),
    experienceLevel: normalizeExperienceLevel(input.experienceLevel),
    workload: pickCleanString(input.workload),
    connectsRequired: toIntOrNull(input.connectsRequired),
    proposalsCount: toIntOrNull(input.proposalsCount),
    interviewingCount: toIntOrNull(input.interviewingCount),
    screeningQuestions: cleanQuestions(input.screeningQuestions),
    client: normalizeClient(input.client),
    raw: input.raw,
  };

  // Guard against inverted ranges from sloppy upstream text.
  if (job.hourlyMin !== null && job.hourlyMax !== null && job.hourlyMin > job.hourlyMax) {
    const min = job.hourlyMax;
    job.hourlyMax = job.hourlyMin;
    job.hourlyMin = min;
  }

  const parsed = rawJobSchema.safeParse(job);
  if (!parsed.success) {
    throw new ValidationError('normalizeJob: produced an invalid RawJob', {
      details: {
        source,
        url,
        issues: parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`),
      },
    });
  }

  return job;
}

/** normalizeJob that logs and returns null instead of throwing. */
export function safeNormalizeJob(input: NormalizeInput): RawJob | null {
  try {
    return normalizeJob(input);
  } catch (err) {
    log.debug({ err, source: input.source }, 'dropping unnormalisable job payload');
    return null;
  }
}

function pickCleanString(value: unknown): string | null {
  const text = toStringOrNull(value);
  if (text === null) return null;
  const cleaned = collapseWhitespace(decodeEntities(text));
  return cleaned === '' ? null : cleaned.slice(0, 255);
}

function toIntOrNull(value: unknown): number | null {
  const parsed = toNumberOrNull(value);
  if (parsed === null) return null;
  const rounded = Math.round(parsed);
  return Number.isSafeInteger(rounded) ? rounded : null;
}

/** Content fingerprint used for change detection and cheap re-crawl no-ops. */
export function contentHashOf(job: RawJob): string {
  return hashJobContent({
    title: job.title,
    description: job.description,
    budgetAmount: job.budgetAmount,
    hourlyMin: job.hourlyMin,
    hourlyMax: job.hourlyMax,
    jobType: job.jobType,
    skills: job.skills,
    screeningQuestions: job.screeningQuestions,
  });
}

/** Key for cross-source dedupe: the canonical URL, falling back to the id. */
export function dedupeUrlKey(job: RawJob): string {
  return job.url.toLowerCase().replace(/\/+$/, '');
}

export function dedupeSourceKey(job: RawJob): string {
  return `${job.source}::${job.externalId}`;
}

import type { Template as TemplateRow } from '@prisma/client';
import { ValidationError, serializeError } from '../lib/errors';
import { sha256Short } from '../lib/hash';
import { containsTerm, isKnownNumber, normalizeJobType, normalizeText } from '../scoring/weights';
import type { JobType } from '../types';
import type { DraftJob, DraftProfile } from './pricing';

/**
 * Proposal skeletons. Each one is five slotted sections - hook, proof, plan,
 * question, CTA - so both the model and the deterministic fallback produce the
 * same shape of letter. The slot list is closed and identical across templates,
 * which is what lets the fallback path fill any template without special cases.
 *
 * This library is the floor. Templates the operator writes in the dashboard win
 * when one applies - see the stored templates section at the end of the file.
 */

export const PROPOSAL_TONES = ['professional', 'friendly', 'expert', 'concise'] as const;
export type ProposalTone = (typeof PROPOSAL_TONES)[number];

export const TEMPLATE_SLOTS = [
  'jobTitle',
  'focus',
  'primarySkill',
  'proofPoint',
  'planStep1',
  'planStep2',
  'planStep3',
  'clarifyingQuestion',
  'availability',
  'priceLine',
] as const;

export type TemplateSlot = (typeof TEMPLATE_SLOTS)[number];

export type TemplateVars = Partial<Record<TemplateSlot, string | number | null | undefined>>;

export type TemplateJobType = JobType | 'ANY';

export interface ProposalTemplate {
  id: string;
  label: string;
  tone: ProposalTone;
  jobType: TemplateJobType;
  hook: string;
  proof: string;
  plan: string;
  question: string;
  cta: string;
}

export const TEMPLATE_SECTIONS: readonly (keyof Pick<
  ProposalTemplate,
  'hook' | 'proof' | 'plan' | 'question' | 'cta'
>)[] = ['hook', 'proof', 'plan', 'question', 'cta'] as const;

export function normalizeTone(value: string | null | undefined): ProposalTone {
  const normalized = normalizeText(value);
  const match = PROPOSAL_TONES.find((tone) => tone === normalized);
  return match ?? 'professional';
}

export const TEMPLATES: readonly ProposalTemplate[] = [
  {
    id: 'professional-outcome',
    label: 'Professional / outcome first',
    tone: 'professional',
    jobType: 'ANY',
    hook: 'You need {{focus}}. That is the work I do day to day, and {{primarySkill}} is the centre of it.',
    proof: '{{proofPoint}}',
    plan: 'How I would run it:\n1. {{planStep1}}\n2. {{planStep2}}\n3. {{planStep3}}',
    question: 'One thing I want to get right before starting: {{clarifyingQuestion}}',
    cta: '{{availability}} {{priceLine}} If that works, reply here and I will send a short scope confirmation before any work begins.',
  },
  {
    id: 'professional-scope',
    label: 'Professional / scope and milestones',
    tone: 'professional',
    jobType: 'FIXED',
    hook: 'Your post asks for {{focus}}. I have read the whole brief and the scope is clear enough to price properly.',
    proof: '{{proofPoint}}',
    plan: 'Proposed milestones:\n1. {{planStep1}}\n2. {{planStep2}}\n3. {{planStep3}}',
    question: 'Before I lock the milestones: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} Happy to adjust the milestone split if you would rather stage it differently.',
  },
  {
    id: 'professional-availability',
    label: 'Professional / hourly cadence',
    tone: 'professional',
    jobType: 'HOURLY',
    hook: 'You are looking for {{focus}} on an ongoing basis. {{primarySkill}} is my main line of work, so I can pick this up without a ramp-up week.',
    proof: '{{proofPoint}}',
    plan: 'First two weeks would look like:\n1. {{planStep1}}\n2. {{planStep2}}\n3. {{planStep3}}',
    question: 'To plan the cadence properly: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} I keep a written update at the end of each week so you always know where the hours went.',
  },
  {
    id: 'friendly-collaborative',
    label: 'Friendly / collaborative',
    tone: 'friendly',
    jobType: 'ANY',
    hook: 'Hi! {{focus}} is exactly the kind of project I enjoy, and it lines up with the {{primarySkill}} work I do most weeks.',
    proof: '{{proofPoint}}',
    plan: 'Here is the plan I have in mind:\n- {{planStep1}}\n- {{planStep2}}\n- {{planStep3}}',
    question: 'Quick question so I do not assume anything: {{clarifyingQuestion}}',
    cta: '{{availability}} {{priceLine}} Send me a message either way - happy to talk through the approach first.',
  },
  {
    id: 'friendly-quickstart',
    label: 'Friendly / quick start',
    tone: 'friendly',
    jobType: 'HOURLY',
    hook: 'Hi! I read your post about {{focus}} and I can start on it right away - {{primarySkill}} is my everyday work.',
    proof: '{{proofPoint}}',
    plan: 'What I would do in the first week:\n- {{planStep1}}\n- {{planStep2}}\n- {{planStep3}}',
    question: 'One thing I would want to check with you: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} Just say the word and I will get set up on my side.',
  },
  {
    id: 'friendly-milestones',
    label: 'Friendly / milestone split',
    tone: 'friendly',
    jobType: 'FIXED',
    hook: 'Hi! {{focus}} is a well-defined piece of work, and it is close to what I build regularly with {{primarySkill}}.',
    proof: '{{proofPoint}}',
    plan: 'I would split it into three milestones:\n- {{planStep1}}\n- {{planStep2}}\n- {{planStep3}}',
    question: 'Before I commit to the split: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} Happy to reshape the milestones around whatever you need first.',
  },
  {
    id: 'expert-diagnostic',
    label: 'Expert / diagnostic',
    tone: 'expert',
    jobType: 'ANY',
    hook: 'The hard part of {{focus}} is usually not the build, it is the decisions around it. That is where {{primarySkill}} experience pays for itself.',
    proof: '{{proofPoint}}',
    plan: 'My approach on "{{jobTitle}}":\n1. {{planStep1}}\n2. {{planStep2}}\n3. {{planStep3}}',
    question: 'The answer that would change my approach: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} If you want, I can send a short written breakdown of the trade-offs before you decide.',
  },
  {
    id: 'expert-fixed-scope',
    label: 'Expert / fixed scope',
    tone: 'expert',
    jobType: 'FIXED',
    hook: 'For {{focus}}, the risk in a fixed price is scope drift, so I price it against a defined deliverable rather than a vague outcome.',
    proof: '{{proofPoint}}',
    plan: 'Deliverables I would commit to:\n1. {{planStep1}}\n2. {{planStep2}}\n3. {{planStep3}}',
    question: 'The one open item in your brief: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}} Anything outside that list we agree separately, so the price stays honest.',
  },
  {
    id: 'concise-three-line',
    label: 'Concise / three lines',
    tone: 'concise',
    jobType: 'ANY',
    hook: '{{focus}} - yes, I can do this. {{primarySkill}} is my core skill.',
    proof: '{{proofPoint}}',
    plan: 'Plan: {{planStep1}}. Then {{planStep2}}. Then {{planStep3}}.',
    question: 'Question: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}}',
  },
  {
    id: 'concise-hourly',
    label: 'Concise / hourly',
    tone: 'concise',
    jobType: 'HOURLY',
    hook: '{{focus}} - this is my day job. {{primarySkill}} specifically.',
    proof: '{{proofPoint}}',
    plan: 'Week one: {{planStep1}}. Week two: {{planStep2}}. Ongoing: {{planStep3}}.',
    question: 'Question: {{clarifyingQuestion}}',
    cta: '{{priceLine}} {{availability}}',
  },
];

const TEMPLATES_BY_ID = new Map<string, ProposalTemplate>(
  TEMPLATES.map((template) => [template.id, template]),
);

export function getTemplate(id: string): ProposalTemplate | null {
  return TEMPLATES_BY_ID.get(id) ?? null;
}

const SLOT_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Slot names referenced anywhere in a string, in first-appearance order. */
export function extractSlots(text: string): string[] {
  const found: string[] = [];
  SLOT_PATTERN.lastIndex = 0;
  let match = SLOT_PATTERN.exec(text);
  while (match !== null) {
    const name = match[1];
    if (!found.includes(name)) found.push(name);
    match = SLOT_PATTERN.exec(text);
  }
  return found;
}

/** The {{slots}} a body uses set against the variables it declares. */
export interface SlotDiff {
  /** Slots referenced in the body, de-duplicated, in first-appearance order. */
  used: string[];
  /** Declared variable names, de-duplicated, in the order given. */
  declared: string[];
  /** Used in the body but never declared: nothing will ever fill them. */
  undeclared: string[];
  /** Declared but absent from the body: they silently do nothing. */
  unused: string[];
}

/**
 * A body and its declared variables have to describe the same set of slots. Both
 * directions matter, so both are reported: the editor names each side, and the
 * write routes refuse a template where either list is non-empty.
 */
export function diffTemplateSlots(body: string, variables: readonly string[]): SlotDiff {
  const used = extractSlots(body);

  const declared: string[] = [];
  for (const raw of variables) {
    const name = (raw ?? '').trim();
    if (name !== '' && !declared.includes(name)) declared.push(name);
  }

  return {
    used,
    declared,
    undeclared: used.filter((slot) => !declared.includes(slot)),
    unused: declared.filter((name) => !used.includes(name)),
  };
}

/** Every slot the template needs filled, across all five sections. */
export function templateSlots(template: ProposalTemplate): string[] {
  const slots: string[] = [];
  for (const section of TEMPLATE_SECTIONS) {
    for (const slot of extractSlots(template[section])) {
      if (!slots.includes(slot)) slots.push(slot);
    }
  }
  return slots;
}

/** The raw skeleton, slots intact, as shown to the model in the prompt. */
export function templateSkeleton(template: ProposalTemplate): string {
  return TEMPLATE_SECTIONS.map((section) => template[section]).join('\n\n');
}

/**
 * Deterministic variant choice: the same posting always renders through the
 * same template, but two postings in the same tone do not read identically.
 */
function pickIndex(job: DraftJob, count: number): number {
  if (count <= 1) return 0;
  const key = job.externalId ?? job.id ?? job.url ?? job.title ?? '';
  const digest = sha256Short(key, 8);
  const value = Number.parseInt(digest, 16);
  return Number.isFinite(value) ? value % count : 0;
}

/**
 * Picks a skeleton for this job and profile: the profile's tone first, then a
 * job-type-specific variant when one exists, falling back through tone-agnostic
 * and finally professional so this can never return undefined.
 */
export function pickTemplate(job: DraftJob, profile: DraftProfile): ProposalTemplate {
  const tone = normalizeTone(profile.proposalTone);
  const jobType = normalizeJobType(job.jobType);

  const typed = TEMPLATES.filter((template) => template.tone === tone && template.jobType === jobType);
  if (typed.length > 0) return typed[pickIndex(job, typed.length)];

  const anyType = TEMPLATES.filter((template) => template.tone === tone && template.jobType === 'ANY');
  if (anyType.length > 0) return anyType[pickIndex(job, anyType.length)];

  const sameType = TEMPLATES.filter((template) => template.jobType === jobType);
  if (sameType.length > 0) return sameType[pickIndex(job, sameType.length)];

  return TEMPLATES[0];
}

function slotValue(vars: TemplateVars, name: string): string | null {
  const raw = (vars as Record<string, unknown>)[name];
  if (raw === null || raw === undefined) return null;
  if (typeof raw === 'number') return Number.isFinite(raw) ? String(raw) : null;
  if (typeof raw !== 'string') return null;
  const trimmed = raw.trim();
  return trimmed === '' ? null : trimmed;
}

/**
 * Strict {{slot}} substitution. Throws on any slot without a usable value so a
 * half-filled letter can never reach a client - guardrails and the generator
 * both rely on this failing loudly rather than emitting "{{proofPoint}}".
 */
export function renderSlots(text: string, vars: TemplateVars, context = 'text'): string {
  const missing: string[] = [];
  const rendered = text.replace(SLOT_PATTERN, (_match, name: string) => {
    const value = slotValue(vars, name);
    if (value === null) {
      if (!missing.includes(name)) missing.push(name);
      return '';
    }
    return value;
  });

  if (missing.length > 0) {
    throw new ValidationError(`unresolved template slots in ${context}: ${missing.join(', ')}`, {
      details: { context, missing },
    });
  }
  return rendered;
}

/** Renders all five sections into a finished cover letter. */
export function renderTemplate(template: ProposalTemplate, vars: TemplateVars): string {
  const sections = TEMPLATE_SECTIONS.map((section) =>
    renderSlots(template[section], vars, `${template.id}.${section}`).trim(),
  ).filter((section) => section !== '');

  return sections.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
}

/* --------------------------------------------------------- stored templates */

/**
 * Templates the operator writes in the dashboard take precedence over the
 * built-in library; the built-ins stay as the floor so a fresh install, an
 * empty table or an unreachable database still drafts something.
 *
 * A stored template is a free-form body with its own declared slots, so it is
 * only ever handed to the model as the skeleton to follow. The deterministic
 * fallback in the generator keeps rendering a built-in, whose closed slot list
 * is the only one deriveTemplateVars() can guarantee to fill.
 */

type PrismaModule = typeof import('../lib/prisma');
type LoggerModule = typeof import('../lib/logger');

interface TemplateStore {
  prisma: PrismaModule['prisma'];
  log: ReturnType<LoggerModule['child']>;
}

let store: Promise<TemplateStore | null> | null = null;

/**
 * lib/prisma and lib/logger both read config/env, which throws in a process
 * that has no DATABASE_URL. Everything above this point is pure, and the prompt
 * and guardrail units are exercised without a database, so the database-backed
 * half is loaded on first use rather than at import time. It resolves to null
 * when there is no usable environment, and selection stays on the built-ins.
 */
function templateStore(): Promise<TemplateStore | null> {
  if (store) return store;

  store = (async (): Promise<TemplateStore | null> => {
    try {
      const { prisma } = (await import('../lib/prisma')) as PrismaModule;
      const { child } = (await import('../lib/logger')) as LoggerModule;
      return { prisma, log: child('proposals.templates') };
    } catch {
      // Nothing to log with - the logger is half of what failed to load.
      return null;
    }
  })();

  return store;
}

/** A Template row narrowed to what selection and prompting need. */
export interface StoredTemplate {
  id: string;
  name: string;
  jobTypes: JobType[];
  tone: ProposalTone;
  categories: string[];
  minScore: number | null;
  body: string;
  variables: string[];
  isDefault: boolean;
  timesUsed: number;
  lastUsedAt: Date | null;
}

/** The skeleton a draft is written against, whichever layer supplied it. */
export interface SelectedTemplate {
  source: 'db' | 'builtin';
  /** The Template row id, or the built-in id when nothing in the table applied. */
  id?: string;
  name: string;
  body: string;
  variables: string[];
  tone: ProposalTone;
}

export const TEMPLATE_CACHE_TTL_MS = 60_000;

interface TemplateCache {
  rows: StoredTemplate[];
  expiresAt: number;
}

let templateCache: TemplateCache | null = null;
let templateLoad: Promise<StoredTemplate[]> | null = null;

function toStored(row: TemplateRow): StoredTemplate {
  const variables = row.variables.map((name) => name.trim()).filter((name) => name !== '');

  return {
    id: row.id,
    name: row.name,
    jobTypes: row.jobTypes.map(normalizeJobType),
    tone: normalizeTone(row.tone),
    categories: row.categories.map((category) => category.trim()).filter((category) => category !== ''),
    minScore: isKnownNumber(row.minScore) ? row.minScore : null,
    body: row.body,
    // A row written outside the API can declare nothing; the body is then the
    // only statement of what has to be filled.
    variables: variables.length > 0 ? variables : extractSlots(row.body),
    isDefault: row.isDefault,
    timesUsed: row.timesUsed,
    lastUsedAt: row.lastUsedAt,
  };
}

/**
 * Active Template rows, cached for 60 seconds and deduped across concurrent
 * callers. Never rejects: a failed read serves the last good list, or an empty
 * one, so drafting falls back to the built-in library instead of stopping.
 */
export async function loadDbTemplates(): Promise<StoredTemplate[]> {
  const cached = templateCache;
  if (cached && cached.expiresAt > Date.now()) return cached.rows;
  if (templateLoad) return templateLoad;

  const pending = (async (): Promise<StoredTemplate[]> => {
    const active = await templateStore();
    if (!active) return templateCache?.rows ?? [];

    try {
      // Defaults first so the fallback below is deterministic if a hand-edited
      // table ever holds two of them; the id keeps the rest stable.
      const rows = await active.prisma.template.findMany({
        where: { isActive: true },
        orderBy: [{ isDefault: 'desc' }, { id: 'asc' }],
      });
      const stored = rows.map(toStored);
      templateCache = { rows: stored, expiresAt: Date.now() + TEMPLATE_CACHE_TTL_MS };
      return stored;
    } catch (err) {
      active.log.warn(
        { err: serializeError(err) },
        'failed to load templates; using the built-in library',
      );
      return templateCache?.rows ?? [];
    }
  })().finally(() => {
    if (templateLoad === pending) templateLoad = null;
  });

  templateLoad = pending;
  return pending;
}

/** Drops the cache so the next selection sees a dashboard edit immediately. */
export function invalidateTemplateCache(): void {
  templateCache = null;
  templateLoad = null;
}

/**
 * Whatever the last successful load returned, with a refresh started in the
 * background once the entry has gone stale. Serving a minute-old list to a
 * caller that cannot await beats ignoring the operator's templates entirely;
 * only a draft in the moments before the first load ever completes sees none.
 */
function peekDbTemplates(): StoredTemplate[] {
  const cached = templateCache;
  if (!cached || cached.expiresAt <= Date.now()) {
    // loadDbTemplates never rejects, so this cannot become an unhandled error.
    void loadDbTemplates();
  }
  return cached?.rows ?? [];
}

/* ------------------------------------------------------------- eligibility */

interface TemplateFit {
  template: StoredTemplate;
  /** How many declared constraints this template had to satisfy to be eligible. */
  constraints: number;
}

/** Exact match on either category, then the overlap the scorer also accepts. */
function categoryMatches(template: StoredTemplate, job: DraftJob): boolean {
  const jobCategories = [normalizeText(job.category), normalizeText(job.subcategory)].filter(
    (category) => category !== '',
  );
  if (jobCategories.length === 0) return false;

  return template.categories.some((raw) => {
    const category = normalizeText(raw);
    if (category === '') return false;
    return jobCategories.some(
      (jobCategory) =>
        jobCategory === category ||
        containsTerm(jobCategory, category) ||
        containsTerm(category, jobCategory),
    );
  });
}

/**
 * Null when a declared constraint fails, otherwise how many constraints the
 * template declared. An empty list or a null minScore is "applies to anything",
 * which is why the count doubles as a specificity ranking.
 */
function fitOf(template: StoredTemplate, job: DraftJob, score: number | null): number | null {
  let constraints = 0;

  if (template.jobTypes.length > 0) {
    if (!template.jobTypes.includes(normalizeJobType(job.jobType))) return null;
    constraints += 1;
  }

  if (template.categories.length > 0) {
    if (!categoryMatches(template, job)) return null;
    constraints += 1;
  }

  if (template.minScore !== null) {
    // An unscored draft cannot clear a floor, so the template is skipped rather
    // than assumed to qualify.
    if (score === null || score < template.minScore) return null;
    constraints += 1;
  }

  return constraints;
}

/** Never used sorts first, which is what makes a new template get its turn. */
function lastUsedMs(template: StoredTemplate): number {
  const at = template.lastUsedAt;
  if (!(at instanceof Date)) return 0;
  const time = at.getTime();
  return Number.isNaN(time) ? 0 : time;
}

/**
 * Most specific first, then the operator's default, then least recently used so
 * equally eligible templates rotate instead of one winning every job. The id
 * breaks the last tie only to keep the choice stable across processes.
 */
function compareFits(a: TemplateFit, b: TemplateFit): number {
  if (a.constraints !== b.constraints) return b.constraints - a.constraints;
  if (a.template.isDefault !== b.template.isDefault) return a.template.isDefault ? -1 : 1;

  const usedA = lastUsedMs(a.template);
  const usedB = lastUsedMs(b.template);
  if (usedA !== usedB) return usedA - usedB;

  if (a.template.timesUsed !== b.template.timesUsed) return a.template.timesUsed - b.template.timesUsed;
  if (a.template.id === b.template.id) return 0;
  return a.template.id < b.template.id ? -1 : 1;
}

function fromStored(template: StoredTemplate): SelectedTemplate {
  return {
    source: 'db',
    id: template.id,
    name: template.name,
    body: template.body,
    variables: template.variables,
    tone: template.tone,
  };
}

/** A built-in skeleton in the same shape a stored template arrives in. */
export function toSelectedTemplate(template: ProposalTemplate): SelectedTemplate {
  return {
    source: 'builtin',
    id: template.id,
    name: template.label,
    body: templateSkeleton(template),
    variables: templateSlots(template),
    tone: template.tone,
  };
}

function normalizeScore(score: number | null | undefined): number | null {
  return isKnownNumber(score) ? score : null;
}

/**
 * The selection itself: an eligible operator template, else the operator's
 * default whatever its constraints say, else the built-in for this job type
 * and tone.
 */
function chooseTemplate(
  rows: readonly StoredTemplate[],
  job: DraftJob,
  profile: DraftProfile,
  score: number | null,
): SelectedTemplate {
  const eligible: TemplateFit[] = [];
  for (const template of rows) {
    const constraints = fitOf(template, job, score);
    if (constraints !== null) eligible.push({ template, constraints });
  }

  if (eligible.length > 0) {
    eligible.sort(compareFits);
    return fromStored(eligible[0].template);
  }

  const fallback = rows.find((template) => template.isDefault);
  if (fallback) return fromStored(fallback);

  return toSelectedTemplate(pickTemplate(job, profile));
}

/** Reads the table (through the 60s cache) and picks the skeleton to follow. */
export async function selectTemplate(
  job: DraftJob,
  profile: DraftProfile,
  score?: number | null,
): Promise<SelectedTemplate> {
  return chooseTemplate(await loadDbTemplates(), job, profile, normalizeScore(score));
}

/**
 * selectTemplate for callers that cannot await: buildPrompts() is synchronous
 * and the generator is built on that. It selects against the cached rows and
 * lets peekDbTemplates() refresh them behind it, so only a draft raced against
 * the very first load ever sees the built-ins when the table has templates.
 */
export function selectTemplateCached(
  job: DraftJob,
  profile: DraftProfile,
  score?: number | null,
): SelectedTemplate {
  return chooseTemplate(peekDbTemplates(), job, profile, normalizeScore(score));
}

/**
 * Stamps a use on a stored template. Fire and forget by design: the draft is
 * already written, and losing a usage counter must never fail a proposal or
 * delay one behind a second round trip. Unknown ids are a no-op - updateMany
 * matches nothing rather than throwing - so a built-in id is harmless here.
 */
export function recordTemplateUse(id: string): void {
  const templateId = (id ?? '').trim();
  if (templateId === '') return;

  const usedAt = new Date();

  // Keep the cached row in step, or the least-recently-used tie-break would
  // hand the same template every job until the cache expires.
  const cached = templateCache?.rows.find((row) => row.id === templateId);
  if (cached) {
    cached.timesUsed += 1;
    cached.lastUsedAt = usedAt;
  }

  void templateStore().then(async (active) => {
    if (!active) return;
    try {
      await active.prisma.template.updateMany({
        where: { id: templateId },
        data: { timesUsed: { increment: 1 }, lastUsedAt: usedAt },
      });
    } catch (err) {
      active.log.warn({ err: serializeError(err), templateId }, 'failed to record template use');
    }
  });
}

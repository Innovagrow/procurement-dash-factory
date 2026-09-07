import { ValidationError } from '../lib/errors';
import { sha256Short } from '../lib/hash';
import { normalizeJobType, normalizeText } from '../scoring/weights';
import type { JobType } from '../types';
import type { DraftJob, DraftProfile } from './pricing';

/**
 * Proposal skeletons. Each one is five slotted sections - hook, proof, plan,
 * question, CTA - so both the model and the deterministic fallback produce the
 * same shape of letter. The slot list is closed and identical across templates,
 * which is what lets the fallback path fill any template without special cases.
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

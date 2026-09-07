import {
  effectiveHourlyRate,
  formatCount,
  formatMoney,
  formatPercent,
  isKnownNumber,
  normalizeJobType,
  truncate,
} from '../scoring/weights';
import { type BidComputation, type DraftJob, type DraftProfile, currencyOf } from './pricing';
import { type ProposalTemplate, normalizeTone, templateSkeleton } from './templates';

/**
 * Prompt construction for the drafting call. Everything the model is allowed to
 * know about the freelancer, the job and the price lives here, together with the
 * response contract the generator parses.
 */

export const MAX_DESCRIPTION_CHARS = 4000;
export const MAX_PROFILE_CHARS = 1600;
export const MAX_PORTFOLIO_ITEMS = 6;
export const MAX_PORTFOLIO_CHARS = 260;
export const MAX_SKILLS = 20;
export const MAX_QUESTIONS = 8;
export const MAX_QUESTION_CHARS = 400;
export const MAX_CUSTOM_INSTRUCTION_CHARS = 800;
export const MAX_ANSWER_CHARS = 600;

export const DEFAULT_PROPOSAL_MAX_CHARS = 1500;
export const MIN_PROPOSAL_MAX_CHARS = 400;
export const MAX_PROPOSAL_MAX_CHARS = 5000;

/** Narrow view of a score. Both `ScoreResult` and a `JobProfileMatch` row fit. */
export interface ScoreSummary {
  score: number;
  decision?: string;
  reasons?: string[];
  matchedKeywords?: string[];
  matchedSkills?: string[];
  llmRationale?: string | null;
}

export interface PromptContext {
  job: DraftJob;
  profile: DraftProfile;
  bid: BidComputation;
  template: ProposalTemplate;
  score?: ScoreSummary | null;
}

export interface BuiltPrompts {
  system: string;
  user: string;
  maxChars: number;
}

const LANGUAGE_NAMES: Record<string, string> = {
  en: 'English',
  es: 'Spanish',
  fr: 'French',
  de: 'German',
  pt: 'Portuguese',
  it: 'Italian',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  uk: 'Ukrainian',
  tr: 'Turkish',
  ar: 'Arabic',
  hi: 'Hindi',
  zh: 'Chinese',
  ja: 'Japanese',
  ko: 'Korean',
};

export function languageName(code: string | null | undefined): string {
  const normalized = (code ?? 'en').trim().toLowerCase();
  const base = normalized.split(/[-_]/)[0];
  return LANGUAGE_NAMES[base] ?? LANGUAGE_NAMES[normalized] ?? normalized.toUpperCase();
}

export function resolveMaxChars(profile: DraftProfile): number {
  const raw = profile.proposalMaxChars;
  if (!isKnownNumber(raw)) return DEFAULT_PROPOSAL_MAX_CHARS;
  return Math.min(MAX_PROPOSAL_MAX_CHARS, Math.max(MIN_PROPOSAL_MAX_CHARS, Math.round(raw)));
}

export function screeningQuestions(job: DraftJob): string[] {
  return (job.screeningQuestions ?? [])
    .map((question) => (question ?? '').trim())
    .filter((question) => question !== '')
    .slice(0, MAX_QUESTIONS)
    .map((question) => truncate(question, MAX_QUESTION_CHARS));
}

/* ----------------------------------------------------------- system prompt */

const TONE_GUIDANCE: Record<string, string> = {
  professional: 'Direct and businesslike. Short paragraphs, no filler, no exclamation marks.',
  friendly: 'Warm and human, still concrete. Contractions are fine; flattery is not.',
  expert: 'Senior practitioner voice. Lead with the trade-off or risk the client has not named yet.',
  concise: 'Ruthlessly short. Every sentence carries information. No preamble, no sign-off block.',
};

export const HARD_RULES: readonly string[] = [
  'Address the actual brief in the first two sentences: name what they asked for in their words.',
  'Never invent credentials, employers, certifications, client names, or project history. Use only the facts given in the freelancer section.',
  'Never invent numbers. Do not state metrics, percentages, multipliers, revenue, or rankings unless that exact figure appears in the freelancer section.',
  'Never promise or guarantee results, rankings, revenue, timelines you were not given, or approval.',
  'Never include an email address, a phone number, a URL, a domain, a social handle, or a calendar link.',
  'Never suggest moving the conversation off Upwork (no Telegram, WhatsApp, Skype, Discord, WeChat, personal email).',
  'Never write "as an AI", "I am an AI language model", "Dear Sir/Madam", or "To whom it may concern".',
  'Do not open with your own name or a generic greeting block. Open with the client problem.',
  'Do not leave any {{placeholder}} or bracketed fill-in text in the output.',
  'Ask exactly one clarifying question, and make it specific to this brief.',
];

export function buildSystemPrompt(profile: DraftProfile): string {
  const tone = normalizeTone(profile.proposalTone);
  const language = languageName(profile.proposalLanguage);
  const maxChars = resolveMaxChars(profile);

  const lines = [
    'You write Upwork proposals for one specific freelancer. You are writing as that freelancer, in the first person.',
    'A proposal that wins is specific about the client problem, honest about the plan, and short.',
    '',
    `Tone: ${tone}. ${TONE_GUIDANCE[tone] ?? TONE_GUIDANCE.professional}`,
    `Language: write the cover letter and all answers in ${language}.`,
    `Length: the cover letter must be under ${maxChars} characters including whitespace. Shorter is better.`,
    '',
    'Rules that are never broken:',
    ...HARD_RULES.map((rule) => `- ${rule}`),
    '',
    'You reply with a single JSON object and nothing else: no prose, no markdown, no code fences.',
  ];

  return lines.filter((line) => line !== undefined).join('\n');
}

/* ------------------------------------------------------------- user prompt */

function freelancerSection(profile: DraftProfile): string {
  const summary = (profile.freelancerProfile ?? '').trim();
  const portfolio = (profile.portfolioHighlights ?? [])
    .map((item) => (item ?? '').trim())
    .filter((item) => item !== '')
    .slice(0, MAX_PORTFOLIO_ITEMS)
    .map((item) => `- ${truncate(item, MAX_PORTFOLIO_CHARS)}`);

  const skills = [...(profile.requiredSkills ?? []), ...(profile.niceToHaveSkills ?? [])]
    .map((skill) => (skill ?? '').trim())
    .filter((skill) => skill !== '')
    .slice(0, MAX_SKILLS);

  const custom = (profile.customInstructions ?? '').trim();

  const lines = [
    '<freelancer>',
    summary === ''
      ? 'No profile summary was provided. Do not invent one: keep claims about experience generic and unverifiable-free.'
      : truncate(summary, MAX_PROFILE_CHARS),
    skills.length > 0 ? `\nSkills the freelancer sells: ${skills.join(', ')}` : '',
    portfolio.length > 0 ? `\nPortfolio highlights (the only concrete history you may cite):\n${portfolio.join('\n')}` : '',
    custom === '' ? '' : `\nOperator instructions (follow unless they conflict with the rules):\n${truncate(custom, MAX_CUSTOM_INSTRUCTION_CHARS)}`,
    '</freelancer>',
  ];

  return lines.filter((line) => line !== '').join('\n');
}

function budgetLine(job: DraftJob): string {
  const type = normalizeJobType(job.jobType);
  const currency = currencyOf(job);
  if (type === 'HOURLY') {
    const min = isKnownNumber(job.hourlyMin) ? formatMoney(job.hourlyMin, currency) : null;
    const max = isKnownNumber(job.hourlyMax) ? formatMoney(job.hourlyMax, currency) : null;
    if (min && max) return `Hourly, posted range ${min} - ${max} per hour`;
    if (max) return `Hourly, up to ${max} per hour`;
    if (min) return `Hourly, from ${min} per hour`;
    return 'Hourly, no range posted';
  }
  if (isKnownNumber(job.budgetAmount)) {
    return `Fixed price, budget ${formatMoney(job.budgetAmount, currency)}`;
  }
  const rate = effectiveHourlyRate(job);
  if (rate !== null) return `Fixed price, client referenced ${formatMoney(rate, currency)} per hour`;
  return 'Fixed price, no budget posted';
}

function jobSection(job: DraftJob): string {
  const skills = (job.skills ?? [])
    .map((skill) => (skill ?? '').trim())
    .filter((skill) => skill !== '')
    .slice(0, MAX_SKILLS);

  const lines = [
    '<job>',
    `Title: ${truncate((job.title ?? '').trim(), 250)}`,
    `Type: ${budgetLine(job)}`,
    job.category ? `Category: ${job.category}${job.subcategory ? ` / ${job.subcategory}` : ''}` : '',
    job.durationLabel ? `Client stated duration: ${job.durationLabel}` : '',
    job.workload ? `Client stated workload: ${job.workload}` : '',
    job.experienceLevel ? `Experience level wanted: ${job.experienceLevel}` : '',
    skills.length > 0 ? `Skills requested: ${skills.join(', ')}` : '',
    'Description (verbatim, may be truncated):',
    truncate((job.description ?? '').trim(), MAX_DESCRIPTION_CHARS),
    '</job>',
  ];

  return lines.filter((line) => line !== '').join('\n');
}

function clientSection(job: DraftJob): string {
  const facts = [
    job.clientCountry ? `Country: ${job.clientCountry}` : '',
    job.clientPaymentVerified === null || job.clientPaymentVerified === undefined
      ? ''
      : `Payment verified: ${job.clientPaymentVerified ? 'yes' : 'no'}`,
    isKnownNumber(job.clientTotalSpent) ? `Total spent on Upwork: ${formatMoney(job.clientTotalSpent, currencyOf(job))}` : '',
    isKnownNumber(job.clientTotalHires) ? `Hires: ${formatCount(job.clientTotalHires)}` : '',
    isKnownNumber(job.clientHireRate) ? `Hire rate: ${formatPercent(job.clientHireRate)}` : '',
    isKnownNumber(job.clientAvgRating) ? `Average rating: ${job.clientAvgRating.toFixed(1)}/5` : '',
    isKnownNumber(job.clientReviewsCount) ? `Reviews: ${formatCount(job.clientReviewsCount)}` : '',
    isKnownNumber(job.proposalsCount) ? `Proposals already submitted: ${formatCount(job.proposalsCount)}` : '',
    isKnownNumber(job.interviewingCount) ? `Candidates interviewing: ${formatCount(job.interviewingCount)}` : '',
  ].filter((fact) => fact !== '');

  if (facts.length === 0) return '';
  return ['<client>', ...facts, 'Do not mention these statistics back to the client.', '</client>'].join('\n');
}

function pricingSection(bid: BidComputation, profile: DraftProfile): string {
  const lines = ['<pricing>'];

  if (bid.hourlyRate !== null) {
    lines.push(`Computed hourly rate: ${bid.hourlyRate} ${bid.currency} per hour.`);
    if (bid.estimatedWeeklyHours !== null) {
      lines.push(`Weekly commitment to offer: about ${bid.estimatedWeeklyHours} hours per week.`);
    }
    lines.push('suggestedBidAmount must be null for an hourly job.');
  } else if (bid.bidAmount !== null) {
    lines.push(`Computed fixed bid: ${bid.bidAmount} ${bid.currency}.`);
    lines.push('suggestedHourlyRate must be null for a fixed-price job.');
  } else {
    lines.push('No bid could be computed from the posting. Leave both amounts null.');
  }

  lines.push(`Estimated duration to state: ${bid.estimatedDurationLabel}.`);
  lines.push(`Why: ${bid.rationale}`);

  if (isKnownNumber(profile.minBid) || isKnownNumber(profile.maxBid)) {
    const min = isKnownNumber(profile.minBid) ? String(profile.minBid) : 'none';
    const max = isKnownNumber(profile.maxBid) ? String(profile.maxBid) : 'none';
    lines.push(`Hard bid bounds: minimum ${min}, maximum ${max}. Anything outside is rejected.`);
  }

  lines.push(
    'Use the computed figures unless the brief makes them clearly wrong; if you change one, stay inside the bounds and say why in the cover letter.',
  );
  lines.push('Never write the currency of another country and never quote a range.');
  lines.push('</pricing>');

  return lines.join('\n');
}

function scoreSection(score: ScoreSummary | null | undefined): string {
  if (!score) return '';
  const reasons = (score.reasons ?? []).slice(0, 6).map((reason) => `- ${truncate(reason, 200)}`);
  const skills = (score.matchedSkills ?? []).slice(0, 12);
  const keywords = (score.matchedKeywords ?? []).slice(0, 12);

  const lines = [
    '<match>',
    `Internal fit score: ${Math.round(score.score)}/100.`,
    skills.length > 0 ? `Skills that matched: ${skills.join(', ')}` : '',
    keywords.length > 0 ? `Keywords that matched: ${keywords.join(', ')}` : '',
    reasons.length > 0 ? `Why it scored that way:\n${reasons.join('\n')}` : '',
    score.llmRationale ? `Fit summary: ${truncate(score.llmRationale, 400)}` : '',
    'This is internal context for you. Never mention scoring, matching, or automation to the client.',
    '</match>',
  ];

  return lines.filter((line) => line !== '').join('\n');
}

function templateSection(template: ProposalTemplate): string {
  return [
    '<skeleton>',
    `Structure to follow (${template.label}). Keep the order and the intent of each block, replace every {{slot}} with real content, and rewrite the wording so it reads naturally for this brief:`,
    templateSkeleton(template),
    '</skeleton>',
  ].join('\n');
}

function questionsSection(job: DraftJob): string {
  const questions = screeningQuestions(job);
  if (questions.length === 0) {
    return ['<screening_questions>', 'None. questionAnswers must be an empty array.', '</screening_questions>'].join('\n');
  }

  return [
    '<screening_questions>',
    'Answer every one of these. Copy each question verbatim into the "question" field.',
    ...questions.map((question, index) => `${index + 1}. ${question}`),
    `Each answer: concrete, first person, under ${MAX_ANSWER_CHARS} characters, no links, no contact details.`,
    '</screening_questions>',
  ].join('\n');
}

export const RESPONSE_CONTRACT = [
  '<output>',
  'Reply with exactly this JSON object and nothing else:',
  '{',
  '  "coverLetter": "string",',
  '  "questionAnswers": [{"question": "string", "answer": "string"}],',
  '  "suggestedBidAmount": number | null,',
  '  "suggestedHourlyRate": number | null,',
  '  "estimatedDurationLabel": "string",',
  '  "confidence": number between 0 and 1',
  '}',
  'confidence is your own honest estimate that this proposal is worth sending as written.',
  'No markdown, no code fence, no commentary before or after the object.',
  '</output>',
].join('\n');

export function buildUserPrompt(ctx: PromptContext): string {
  const maxChars = resolveMaxChars(ctx.profile);
  const sections = [
    freelancerSection(ctx.profile),
    jobSection(ctx.job),
    clientSection(ctx.job),
    scoreSection(ctx.score),
    pricingSection(ctx.bid, ctx.profile),
    templateSection(ctx.template),
    questionsSection(ctx.job),
    `Write the proposal now. Hard limit: ${maxChars} characters for coverLetter.`,
    RESPONSE_CONTRACT,
  ];

  return sections.filter((section) => section !== '').join('\n\n');
}

export function buildPrompts(ctx: PromptContext): BuiltPrompts {
  return {
    system: buildSystemPrompt(ctx.profile),
    user: buildUserPrompt(ctx),
    maxChars: resolveMaxChars(ctx.profile),
  };
}

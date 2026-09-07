import { formatMoney, isKnownNumber, normalizeJobType, normalizeText, truncate } from '../scoring/weights';
import type { QuestionAnswer } from '../types';
import { type DraftJob, type DraftProfile, currencyOf, roundBid, roundRate } from './pricing';
import { MAX_ANSWER_CHARS, resolveMaxChars, screeningQuestions } from './prompt';

/**
 * Last gate before a draft is persisted. Anything that can be repaired without
 * changing the meaning of the letter is repaired and reported as a warning;
 * anything that would need a human decision becomes an error, which routes the
 * proposal to DRAFT instead of PENDING_APPROVAL.
 */

export const MIN_COVER_LETTER_CHARS = 180;
export const MIN_COVER_LETTER_WORDS = 35;
export const MIN_ANSWER_CHARS = 3;
/** How far over the client's own budget a bid may sit before we flag it. */
export const OVERBID_FACTOR = 2;

export const BANNED_PHRASES: readonly string[] = [
  'as an ai',
  'i am an ai',
  'as an artificial intelligence',
  'as a language model',
  'dear sir/madam',
  'dear sir or madam',
  'dear sir',
  'dear madam',
  'to whom it may concern',
  'i cannot fulfill',
  'i do not have personal experience',
];

/** Phrases that are a contact solicitation whatever the surrounding sentence says. */
export const OFF_PLATFORM_SOLICITATIONS: readonly string[] = [
  'email me at',
  'text me at',
  'call me at',
  'reach me at',
  'reach me on',
  'contact me directly',
  'contact me at',
  'contact me on',
  'add me on',
  'message me on',
  'dm me on',
  'ping me on',
  'my telegram',
  'my whatsapp',
  'my skype',
  'my discord',
  'my personal email',
  'my email is',
  'my number is',
  '@gmail',
  '@hotmail',
  '@yahoo',
  '@outlook',
  '@proton',
  'gmail dot com',
  'dot com',
  'off upwork',
  'outside upwork',
  'outside of upwork',
  'off the platform',
  'off platform',
];

/**
 * Platform names on their own are not a violation - "Discord bot development"
 * is a real Upwork job - so they only trip the sanitiser when the same sentence
 * also reads as an invitation to move the conversation.
 */
export const OFF_PLATFORM_TERMS: readonly string[] = [
  'telegram',
  'whatsapp',
  'whats app',
  'skype',
  'discord',
  'wechat',
  'viber',
];

const CONTACT_INTENT_PATTERN =
  /\b(?:contact|reach|message|msg|dm|add|ping|text|call|find|hit)\s+(?:me|us)\b|\b(?:let'?s|we can|we could)\s+(?:talk|chat|connect|continue|speak)\b|\b(?:move|take|continue)\s+(?:this|it|the conversation)\b|\bmy\s+(?:handle|username|id|number)\b/i;

const EMAIL_PATTERN = /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi;

/** Deliberately narrow: broad digit runs match budgets and dates, not phones. */
const PHONE_PATTERNS: readonly RegExp[] = [
  /\+\d[\d\s().-]{7,16}\d/g,
  /\(\d{3}\)\s*\d{3}[-.\s]?\d{4}/g,
  /\b\d{3}[-.\s]\d{3}[-.\s]\d{4}\b/g,
  /\b\d{5}[-.\s]?\d{6}\b/g,
];

const URL_PATTERN = /\b(?:https?:\/\/|www\.)[^\s<>()]+/gi;
/** ".io" is deliberately absent: socket.io and friends are libraries, not links. */
const DOMAIN_PATTERN =
  /\b[a-z0-9][a-z0-9-]{1,62}\.(?:com|net|org|co|me|ai|app|xyz|site|info|biz|online|store|link|page)\b(?:\/[^\s]*)?/gi;
const HANDLE_PATTERN = /(^|[\s(])@[a-z0-9._-]{3,30}\b/gi;
const PLACEHOLDER_PATTERN = /\{\{[^}]*\}\}|\[[A-Za-z][A-Za-z0-9 _/-]{2,40}\]/g;
const PERCENT_CLAIM_PATTERN = /\b\d{1,3}(?:\.\d+)?\s*%/g;
const MULTIPLIER_CLAIM_PATTERN = /\b\d{1,3}(?:\.\d+)?\s*x\b/gi;

const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  JPY: '¥',
  INR: '₹',
  AUD: '$',
  CAD: '$',
};

export interface SanitizedProposal {
  coverLetter: string;
  bidAmount: number | null;
  hourlyRate: number | null;
  estimatedDurationLabel: string | null;
  questionAnswers: QuestionAnswer[];
  currency: string;
}

export interface ProposalDraftInput {
  coverLetter: string;
  bidAmount?: number | null;
  hourlyRate?: number | null;
  estimatedDurationLabel?: string | null;
  questionAnswers?: QuestionAnswer[];
  currency?: string | null;
}

export interface GuardrailResult {
  ok: boolean;
  warnings: string[];
  errors: string[];
  sanitized: SanitizedProposal;
}

/* ------------------------------------------------------------ text helpers */

/** Splits on sentence ends and hard line breaks. */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((part) => part.trim())
    .filter((part) => part !== '');
}

function tidy(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .replace(/\s+([.,;:!?])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

export function findUnresolvedPlaceholders(text: string): string[] {
  const found: string[] = [];
  PLACEHOLDER_PATTERN.lastIndex = 0;
  let match = PLACEHOLDER_PATTERN.exec(text);
  while (match !== null) {
    const token = match[0].trim();
    if (!found.includes(token)) found.push(token);
    match = PLACEHOLDER_PATTERN.exec(text);
  }
  return found;
}

export interface ContactStripResult {
  text: string;
  findings: string[];
}

/**
 * Removes contact details and links. Emails and URLs go first so their "@" and
 * "." do not feed the handle and domain passes.
 */
export function stripContacts(input: string): ContactStripResult {
  const findings: string[] = [];
  let text = input ?? '';

  const replace = (pattern: RegExp, label: string): void => {
    let hit = false;
    text = text.replace(pattern, () => {
      hit = true;
      return ' ';
    });
    if (hit && !findings.includes(label)) findings.push(label);
  };

  replace(EMAIL_PATTERN, 'email address');
  replace(URL_PATTERN, 'link');
  for (const pattern of PHONE_PATTERNS) replace(pattern, 'phone number');
  replace(DOMAIN_PATTERN, 'domain name');
  text = text.replace(HANDLE_PATTERN, (_match, prefix: string) => {
    if (!findings.includes('social handle')) findings.push('social handle');
    return prefix;
  });

  return { text: tidy(text), findings };
}

interface SentenceFilterResult {
  text: string;
  hits: string[];
}

/** Drops whole sentences containing a term, so no dangling half-clause remains. */
function dropSentencesContaining(text: string, terms: readonly string[]): SentenceFilterResult {
  const hits: string[] = [];
  const kept = splitSentences(text).filter((sentence) => {
    const haystack = normalizeText(sentence);
    const hit = terms.find((term) => haystack.includes(term));
    if (hit === undefined) return true;
    if (!hits.includes(hit)) hits.push(hit);
    return false;
  });
  return { text: tidy(kept.join(' ')), hits };
}

/**
 * Platform mentions are removed only when the sentence also reads as an
 * invitation to talk elsewhere; otherwise they are reported so a human can look,
 * because the client may genuinely be hiring for that platform.
 */
export function filterOffPlatform(text: string): SentenceFilterResult & { mentioned: string[] } {
  const hits: string[] = [];
  const mentioned: string[] = [];

  const kept = splitSentences(text).filter((sentence) => {
    const haystack = normalizeText(sentence);

    const solicitation = OFF_PLATFORM_SOLICITATIONS.find((term) => haystack.includes(term));
    if (solicitation !== undefined) {
      if (!hits.includes(solicitation)) hits.push(solicitation);
      return false;
    }

    const platform = OFF_PLATFORM_TERMS.find((term) => haystack.includes(term));
    if (platform === undefined) return true;

    if (CONTACT_INTENT_PATTERN.test(sentence)) {
      if (!hits.includes(platform)) hits.push(platform);
      return false;
    }
    if (!mentioned.includes(platform)) mentioned.push(platform);
    return true;
  });

  return { text: tidy(kept.join(' ')), hits, mentioned };
}

/** Trims to a sentence boundary when one is close enough, else to a word. */
export function trimToSentenceBoundary(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const slice = text.slice(0, maxChars);

  const lastSentence = Math.max(
    slice.lastIndexOf('.'),
    slice.lastIndexOf('!'),
    slice.lastIndexOf('?'),
  );
  if (lastSentence >= Math.floor(maxChars * 0.6)) {
    return slice.slice(0, lastSentence + 1).trim();
  }

  const lastSpace = slice.lastIndexOf(' ');
  return (lastSpace > 0 ? slice.slice(0, lastSpace) : slice).trim();
}

export function wordsIn(text: string): number {
  const trimmed = text.trim();
  return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/**
 * Bare "40%" / "3x" claims are the classic hallucination in a generated
 * proposal. Anything whose figure is not already in the freelancer's own
 * material (or the client's brief) is flagged for a human to confirm.
 */
export function findUnsupportedMetrics(text: string, evidence: string): string[] {
  const haystack = normalizeText(evidence);
  const flagged: string[] = [];

  const scan = (pattern: RegExp): void => {
    pattern.lastIndex = 0;
    let match = pattern.exec(text);
    while (match !== null) {
      const claim = match[0].trim();
      const digits = claim.replace(/[^\d.]/g, '');
      if (digits !== '' && !haystack.includes(digits) && !flagged.includes(claim)) {
        flagged.push(claim);
      }
      match = pattern.exec(text);
    }
  };

  scan(PERCENT_CLAIM_PATTERN);
  scan(MULTIPLIER_CLAIM_PATTERN);
  return flagged;
}

/* ------------------------------------------------------ screening questions */

function bestAnswerFor(
  question: string,
  answers: QuestionAnswer[],
  used: Set<number>,
  index: number,
): { answer: string; matchedIndex: number } | null {
  const needle = normalizeText(question);

  for (let i = 0; i < answers.length; i += 1) {
    if (used.has(i)) continue;
    if (normalizeText(answers[i].question) === needle) {
      return { answer: answers[i].answer, matchedIndex: i };
    }
  }

  for (let i = 0; i < answers.length; i += 1) {
    if (used.has(i)) continue;
    const candidate = normalizeText(answers[i].question);
    if (candidate !== '' && (candidate.includes(needle) || needle.includes(candidate))) {
      return { answer: answers[i].answer, matchedIndex: i };
    }
  }

  // Positional fallback: models occasionally paraphrase the question text.
  if (index < answers.length && !used.has(index)) {
    return { answer: answers[index].answer, matchedIndex: index };
  }
  return null;
}

function sanitizeAnswer(raw: string): string {
  const stripped = stripContacts(raw ?? '');
  const banned = dropSentencesContaining(stripped.text, BANNED_PHRASES);
  const offPlatform = filterOffPlatform(banned.text);
  const withoutPlaceholders = offPlatform.text.replace(PLACEHOLDER_PATTERN, '');
  return trimToSentenceBoundary(tidy(withoutPlaceholders), MAX_ANSWER_CHARS);
}

/* -------------------------------------------------------------- validation */

function detectCurrencyMismatch(text: string, currency: string): string | null {
  const expected = CURRENCY_SYMBOLS[currency] ?? '';
  const upper = text.toUpperCase();

  for (const [code, symbol] of Object.entries(CURRENCY_SYMBOLS)) {
    if (code === currency) continue;
    if (symbol !== '' && symbol !== expected && text.includes(symbol)) return code;
    if (new RegExp(`\\b${code}\\b`).test(upper)) return code;
  }
  return null;
}

/**
 * Validates and repairs a draft against the job and the profile. Never throws:
 * a draft that cannot be repaired comes back with errors and ok=false, and the
 * caller decides what to do with it.
 */
export function validateProposal(
  draft: ProposalDraftInput,
  job: DraftJob,
  profile: DraftProfile,
): GuardrailResult {
  const warnings: string[] = [];
  const errors: string[] = [];

  const currency = currencyOf(job);
  const maxChars = resolveMaxChars(profile);
  const jobType = normalizeJobType(job.jobType);

  /* ---------------------------------------------------------- cover letter */

  let letter = tidy(draft.coverLetter ?? '');

  const placeholders = findUnresolvedPlaceholders(letter);
  if (placeholders.length > 0) {
    errors.push(
      `cover letter still contains unresolved placeholders: ${placeholders.slice(0, 5).join(', ')}`,
    );
    letter = tidy(letter.replace(PLACEHOLDER_PATTERN, ''));
  }

  const contacts = stripContacts(letter);
  if (contacts.findings.length > 0) {
    warnings.push(`removed ${contacts.findings.join(', ')} from the cover letter`);
  }
  letter = contacts.text;

  const banned = dropSentencesContaining(letter, BANNED_PHRASES);
  if (banned.hits.length > 0) {
    warnings.push(`removed sentences containing banned phrasing: ${banned.hits.join(', ')}`);
  }
  letter = banned.text;

  const offPlatform = filterOffPlatform(letter);
  if (offPlatform.hits.length > 0) {
    warnings.push(`removed off-platform contact attempt: ${offPlatform.hits.join(', ')}`);
  }
  if (offPlatform.mentioned.length > 0) {
    warnings.push(`mentions ${offPlatform.mentioned.join(', ')}; confirm it refers to the work itself`);
  }
  letter = offPlatform.text;

  if (letter.length > maxChars) {
    letter = trimToSentenceBoundary(letter, maxChars);
    warnings.push(`cover letter was over ${maxChars} characters and was trimmed`);
  }

  if (letter.trim() === '') {
    errors.push('cover letter is empty after sanitisation');
  } else if (letter.length < MIN_COVER_LETTER_CHARS || wordsIn(letter) < MIN_COVER_LETTER_WORDS) {
    errors.push(
      `cover letter is too short after sanitisation (${letter.length} chars, ${wordsIn(letter)} words)`,
    );
  }

  const evidence = [
    profile.freelancerProfile ?? '',
    ...(profile.portfolioHighlights ?? []),
    profile.customInstructions ?? '',
    job.description ?? '',
    job.title ?? '',
  ].join(' \n ');

  const metrics = findUnsupportedMetrics(letter, evidence);
  if (metrics.length > 0) {
    warnings.push(
      `unverifiable metric claims, confirm before sending: ${metrics.slice(0, 5).join(', ')}`,
    );
  }

  const symbolMismatch = detectCurrencyMismatch(letter, currency);
  if (symbolMismatch !== null) {
    warnings.push(`cover letter mentions ${symbolMismatch} but the job is priced in ${currency}`);
  }

  /* ----------------------------------------------------------------- money */

  const declaredCurrency = (draft.currency ?? currency).trim().toUpperCase();
  if (declaredCurrency !== currency) {
    errors.push(`draft currency ${declaredCurrency} does not match the job currency ${currency}`);
  }

  let bidAmount = isKnownNumber(draft.bidAmount) ? draft.bidAmount : null;
  let hourlyRate = isKnownNumber(draft.hourlyRate) ? draft.hourlyRate : null;

  const minBid = isKnownNumber(profile.minBid) && profile.minBid > 0 ? profile.minBid : null;
  const maxBid = isKnownNumber(profile.maxBid) && profile.maxBid > 0 ? profile.maxBid : null;

  if (jobType === 'HOURLY') {
    if (bidAmount !== null) {
      bidAmount = null;
      warnings.push('dropped the fixed bid amount: this is an hourly job');
    }

    if (hourlyRate === null || hourlyRate <= 0) {
      errors.push('hourly job has no usable hourly rate');
      hourlyRate = null;
    } else {
      const floor = isKnownNumber(profile.hourlyRate) && profile.hourlyRate > 0 ? profile.hourlyRate : null;
      const postedCeiling = isKnownNumber(job.hourlyMax) && job.hourlyMax > 0 ? job.hourlyMax : null;
      // A ceiling under our own floor is the client's problem, not ours: the
      // floor wins and the operator sees the warning.
      const ceiling = floor !== null && postedCeiling !== null && floor > postedCeiling ? null : postedCeiling;

      const adjusted = roundRate(hourlyRate, floor, ceiling);
      if (adjusted !== hourlyRate) {
        warnings.push(
          `hourly rate adjusted from ${formatMoney(hourlyRate, currency)} to ${formatMoney(adjusted, currency)} to respect the profile floor and the posted ceiling`,
        );
        hourlyRate = adjusted;
      }
      if (postedCeiling !== null && hourlyRate > postedCeiling) {
        warnings.push(
          `rate is above the client's posted ceiling of ${formatMoney(postedCeiling, currency)}`,
        );
      }
    }
  } else {
    if (hourlyRate !== null) {
      hourlyRate = null;
      warnings.push('dropped the hourly rate: this is a fixed-price job');
    }

    if (bidAmount === null || bidAmount <= 0) {
      errors.push('fixed-price job has no usable bid amount');
      bidAmount = null;
    } else {
      const adjusted = roundBid(bidAmount, minBid, maxBid);
      if (adjusted !== bidAmount) {
        warnings.push(
          `bid adjusted from ${formatMoney(bidAmount, currency)} to ${formatMoney(adjusted, currency)} to stay inside the profile bounds`,
        );
        bidAmount = adjusted;
      }
      if (minBid !== null && bidAmount < minBid) {
        errors.push(
          `bid ${formatMoney(bidAmount, currency)} is below the profile minimum ${formatMoney(minBid, currency)}`,
        );
      }
      if (maxBid !== null && bidAmount > maxBid) {
        errors.push(
          `bid ${formatMoney(bidAmount, currency)} is above the profile maximum ${formatMoney(maxBid, currency)}`,
        );
      }
      if (
        isKnownNumber(job.budgetAmount) &&
        job.budgetAmount > 0 &&
        bidAmount > job.budgetAmount * OVERBID_FACTOR
      ) {
        warnings.push(
          `bid ${formatMoney(bidAmount, currency)} is more than ${OVERBID_FACTOR}x the posted budget of ${formatMoney(job.budgetAmount, currency)}`,
        );
      }
    }
  }

  /* --------------------------------------------------- screening questions */

  const questions = screeningQuestions(job);
  const provided = (draft.questionAnswers ?? []).filter(
    (entry): entry is QuestionAnswer => Boolean(entry) && typeof entry.answer === 'string',
  );
  const used = new Set<number>();
  const answers: QuestionAnswer[] = [];

  questions.forEach((question, index) => {
    const match = bestAnswerFor(question, provided, used, index);
    if (match === null) {
      errors.push(`no answer for screening question: "${truncate(question, 120)}"`);
      return;
    }
    used.add(match.matchedIndex);

    const answer = sanitizeAnswer(match.answer);
    if (answer.length < MIN_ANSWER_CHARS) {
      errors.push(`answer is empty for screening question: "${truncate(question, 120)}"`);
      return;
    }
    if (answer !== match.answer.trim()) {
      warnings.push(`answer ${index + 1} was sanitised`);
    }
    answers.push({ question, answer });
  });

  const extras = provided.length - used.size;
  if (extras > 0) {
    warnings.push(
      questions.length > 0
        ? `dropped ${extras} answer(s) that did not match a screening question`
        : `dropped ${extras} answer(s): this job has no screening questions`,
    );
  }

  /* -------------------------------------------------------------- duration */

  let durationLabel = (draft.estimatedDurationLabel ?? '').trim();
  if (durationLabel === '') {
    warnings.push('no estimated duration was produced');
  } else if (durationLabel.length > 120) {
    durationLabel = truncate(durationLabel, 120);
  }

  return {
    ok: errors.length === 0,
    warnings,
    errors,
    sanitized: {
      coverLetter: letter,
      bidAmount,
      hourlyRate,
      estimatedDurationLabel: durationLabel === '' ? null : durationLabel,
      questionAnswers: answers,
      currency,
    },
  };
}

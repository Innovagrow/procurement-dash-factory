import type { RedFlag, RedFlagSeverity } from '../types';
import {
  type ScorableJob,
  bulletCount,
  effectiveHourlyRate,
  formatMoney,
  isKnownNumber,
  jobText,
  normalizeText,
  toDate,
  truncate,
  wordCount,
} from './weights';

/**
 * Scam and time-waster detection. Red flags do not replace the hard filters:
 * a filter says "this job does not match the profile", a red flag says "this
 * posting looks dangerous or dishonest regardless of how well it matches".
 *
 * HIGH severity is a veto - the scorer refuses to bid. MEDIUM and LOW are
 * point penalties, so a strong job with one soft flag can still reach review.
 */

export const RED_FLAG_PENALTIES: Record<RedFlagSeverity, number> = {
  HIGH: 100,
  MEDIUM: 15,
  LOW: 5,
};

/** Cap on the combined MEDIUM/LOW penalty so soft flags cannot themselves veto. */
export const MAX_SOFT_PENALTY = 40;

interface PatternRule {
  code: string;
  severity: RedFlagSeverity;
  describe: (evidence: string) => string;
  patterns: RegExp[];
  scope?: 'all' | 'title' | 'description';
}

/**
 * "telegram" alone is a legitimate job topic (bot development); "telegram" next
 * to "contact me" is not. Proximity patterns encode that difference in both
 * directions within a small window.
 */
function nearPatterns(left: string[], right: string[], window = 60): RegExp[] {
  const a = `(?:${left.join('|')})`;
  const b = `(?:${right.join('|')})`;
  return [
    new RegExp(`${a}[^.!?\\n]{0,${window}}?${b}`),
    new RegExp(`${b}[^.!?\\n]{0,${window}}?${a}`),
  ];
}

const CONTACT_CHANNELS = ['telegram', 'whats ?app', 'skype', 'wechat', 'viber', 'signal app'];
const CONTACT_INTENT = [
  'contact (?:me|us)',
  'message (?:me|us)',
  'reach (?:me|us)',
  'dm (?:me|us)',
  'add me',
  'ping me',
  'my (?:id|handle|username)',
  'chat (?:with )?(?:me|us)',
  'text me',
  'get in touch',
];

const PATTERN_RULES: PatternRule[] = [
  {
    code: 'OFF_PLATFORM_CONTACT',
    severity: 'HIGH',
    describe: (evidence) => `asks to move the conversation off Upwork ("${evidence}")`,
    patterns: [
      ...nearPatterns(CONTACT_CHANNELS, CONTACT_INTENT),
      /(?:telegram|whats ?app|skype|wechat)\s*[:@=-]\s*[a-z0-9_.+]{3,}/,
      /\bt\.me\/[a-z0-9_]{3,}/,
      /\b(?:contact|email|reach|write)\s+(?:me|us)\s+(?:at|on|via)\s+[a-z0-9._%+-]+@/,
      /[a-z0-9._%+-]+@(?:gmail|yahoo|outlook|hotmail|protonmail|proton|mail|yandex)\.[a-z]{2,}/,
    ],
  },
  {
    code: 'OFF_PLATFORM_PAYMENT',
    severity: 'HIGH',
    describe: (evidence) => `solicits payment outside Upwork ("${evidence}")`,
    patterns: [
      /\bpay(?:ment|ments)?\s+(?:will be\s+|is\s+|are\s+)?(?:made\s+)?(?:outside|off|out of)\s+(?:of\s+)?(?:the\s+)?upwork\b/,
      /\bwork(?:ing)?\s+(?:directly\s+)?outside\s+(?:of\s+)?(?:the\s+)?(?:upwork|platform)\b/,
      /\boff[- ]?(?:platform|upwork)\s+(?:payment|deal|contract|hire)/,
      /\b(?:avoid|skip|bypass|save on)\s+(?:the\s+)?upwork\s+(?:fee|fees|commission)/,
      ...nearPatterns(
        ['pay(?:ment)?', 'paid', 'salary'],
        ['usdt', 'bitcoin', '\\bbtc\\b', 'ethereum', 'crypto(?:currency)?', 'binance', 'wire transfer', 'western union', 'zelle', 'cash app'],
        40,
      ),
    ],
  },
  {
    code: 'CREDENTIAL_REQUEST',
    severity: 'HIGH',
    describe: (evidence) => `asks for credentials or identity documents ("${evidence}")`,
    patterns: [
      ...nearPatterns(
        ['send', 'share', 'provide', 'give (?:me|us)', 'hand over'],
        [
          'your (?:login|password|credentials)',
          'account (?:login|password|credentials|access)',
          'upwork (?:login|password)',
          '2fa',
          'otp',
          'one[- ]time (?:code|password)',
          'seed phrase',
          'private key',
          'api key',
        ],
        50,
      ),
      /\b(?:access to your)\s+(?:upwork\s+)?(?:account|profile|bank|wallet)\b/,
      /\b(?:passport|driver'?s? licen[cs]e|national id|ssn|social security number)\b[^.!?\n]{0,50}(?:before|upfront|to start|first)/,
      /\bselfie (?:with|holding)\s+(?:your\s+)?(?:id|passport)\b/,
    ],
  },
  {
    code: 'ACADEMIC_DISHONESTY',
    severity: 'HIGH',
    describe: (evidence) => `asks for academic work to be passed off as the client's ("${evidence}")`,
    patterns: [
      /\b(?:write|do|complete|finish|solve|take)\s+(?:my|his|her|their)\s+(?:online\s+)?(?:exam|test|quiz|assignment|homework|coursework|thesis|dissertation|essay|class)\b/,
      /\btake\s+my\s+(?:online\s+)?(?:class|course|exam)\b/,
      /\b(?:attend|sit)\s+(?:my|the)\s+(?:online\s+)?(?:class|exam)\s+for me\b/,
      /\bghost ?writ(?:e|ing)\b[^.!?\n]{0,40}(?:thesis|dissertation|assignment|coursework)/,
      /\bpass my (?:exam|certification|test)\b/,
      /\b(?:log ?in|login) (?:to|into) my (?:university|school|college|canvas|blackboard|moodle) (?:account|portal)\b/,
    ],
  },
  {
    code: 'IMPERSONATION',
    severity: 'HIGH',
    describe: (evidence) => `asks the freelancer to impersonate someone ("${evidence}")`,
    patterns: [
      /\b(?:pretend to be|pose as|impersonate|act as)\s+(?:me|us|our|my|the (?:owner|founder|ceo))\b/,
      /\buse (?:your|my) (?:real )?(?:name|identity|photo|face|profile|account)\b[^.!?\n]{0,40}(?:instead|for (?:the|our)|on (?:the )?call)/,
      /\b(?:proxy|shadow) interview\b/,
      /\b(?:attend|join|do)\s+(?:the\s+)?interview\s+(?:on my behalf|for me|as me)\b/,
      /\b(?:we|i) will use your (?:profile|account|identity|resume|cv)\b/,
      /\b(?:create|open|manage)\s+(?:fake|multiple|several)\s+(?:accounts|profiles)\b/,
      /\b(?:write|post|leave)\s+(?:fake|paid)\s+reviews?\b/,
    ],
  },
  {
    code: 'UNPAID_WORK',
    severity: 'HIGH',
    describe: (evidence) => `explicitly unpaid work is requested ("${evidence}")`,
    patterns: [
      /\b(?:unpaid|no pay|without payment|for free)\s+(?:test|trial|sample|task|assignment|work|project|demo|period)\b/,
      /\b(?:test|trial|sample)\s+(?:task|project|work|assignment)\b[^.!?\n]{0,40}\b(?:unpaid|not paid|no payment|for free)\b/,
      /\bno payment (?:until|unless|before)\b/,
    ],
  },
  {
    code: 'FREE_TEST_REQUEST',
    severity: 'MEDIUM',
    describe: (evidence) => `wants a test or sample before any contract ("${evidence}")`,
    patterns: [
      /\b(?:small|quick|short|simple)?\s?(?:test|sample|trial|demo)\s+(?:task|project|work|piece|article|design)\b[^.!?\n]{0,60}\b(?:first|before|prior to|to (?:be )?(?:considered|qualify)|then we)\b/,
      /\b(?:complete|do|submit|send)\s+(?:a\s+)?(?:short\s+|small\s+|quick\s+)?(?:test|sample|trial)\b[^.!?\n]{0,40}\bbefore\b/,
      /\bprove your skills?\b[^.!?\n]{0,40}\b(?:free|sample|test)\b/,
      /\bfirst (?:task|article|design) is (?:free|unpaid|a test)\b/,
    ],
  },
  {
    code: 'MLM_SCHEME',
    severity: 'HIGH',
    describe: (evidence) => `multi-level-marketing or recruitment scheme ("${evidence}")`,
    patterns: [
      /\b(?:mlm|multi[- ]level marketing|network marketing|downline|upline|matrix plan|pyramid plan)\b/,
      /\brecruit(?:ing|ment of)?\s+(?:other\s+)?(?:members|distributors|agents|people)\b[^.!?\n]{0,40}\b(?:commission|bonus|earn)\b/,
    ],
  },
  {
    code: 'GET_RICH_SPAM',
    severity: 'MEDIUM',
    describe: (evidence) => `get-rich-quick language ("${evidence}")`,
    patterns: [
      /\b(?:be your own boss|financial freedom|unlimited (?:earning|income)|passive income opportunity|life[- ]changing income)\b/,
      /\bearn (?:up to )?\$\s?\d[\d,]*\s*(?:\+|plus)?\s*(?:per|a|each|every)\s*(?:day|week)\b/,
      /\bwork from home\b[^.!?\n]{0,40}\bearn\b[^.!?\n]{0,20}\$\s?\d/,
      /\bno (?:experience|skills?) (?:needed|required)\b[^.!?\n]{0,60}\bearn\b/,
    ],
  },
  {
    code: 'DATA_ENTRY_SPAM',
    severity: 'MEDIUM',
    describe: (evidence) => `low-value bulk task pattern ("${evidence}")`,
    patterns: [
      /\b(?:simple|easy|basic|quick)\s+(?:data entry|typing|copy[- ]?paste)\b/,
      /\bcopy(?:\s+and\s+|[- ])paste\s+(?:job|work|task|project)\b/,
      /\b(?:captcha (?:solving|entry)|form filling|ad posting|click(?:ing)? ads|survey filling|like and share)\b/,
      /\b(?:typing|data entry)\s+(?:job|work)\b[^.!?\n]{0,40}\b(?:home|anyone|no experience)\b/,
    ],
  },
];

const BOILERPLATE_PHRASES = [
  'we are looking for a talented',
  'must be able to work independently',
  'only serious applicants',
  'apply now if interested',
  'long term relationship for the right candidate',
  'please start your proposal with',
  'this is a long term project for the right person',
  'rockstar developer',
  'ninja developer',
  'i need someone who can start immediately',
  'budget is flexible for the right candidate',
];

function findEvidence(text: string, patterns: RegExp[]): string | null {
  for (const pattern of patterns) {
    const match = pattern.exec(text);
    if (match && match[0].trim() !== '') return truncate(match[0].trim(), 90);
  }
  return null;
}


function upperCaseRatio(text: string): number {
  const letters = text.replace(/[^a-zA-Z]/g, '');
  if (letters.length < 10) return 0;
  const upper = letters.replace(/[^A-Z]/g, '').length;
  return upper / letters.length;
}

/* ------------------------------------------------------- structural checks */

function unrealisticBudget(job: ScorableJob): RedFlag | null {
  const words = wordCount(job.description ?? '');
  const budget = job.budgetAmount;
  const hourly = effectiveHourlyRate(job);

  if (isKnownNumber(budget) && budget > 0) {
    if (budget < 30 && words > 150) {
      return {
        code: 'UNREALISTIC_BUDGET',
        severity: 'HIGH',
        message: `${formatMoney(budget, job.currency)} for a ${words}-word specification is not a real budget`,
      };
    }
    if ((budget < 100 && words > 300) || (budget < 250 && words > 700)) {
      return {
        code: 'UNREALISTIC_BUDGET',
        severity: 'MEDIUM',
        message: `${formatMoney(budget, job.currency)} is far below what a ${words}-word scope implies`,
      };
    }
    const bigTicket = /\b(?:e-?commerce (?:site|platform|store)|marketplace|mobile app|ios and android|saas platform|full[- ]stack|erp|crm system|trading bot|ai platform)\b/;
    if (budget < 500 && bigTicket.test(normalizeText(job.description))) {
      return {
        code: 'UNREALISTIC_BUDGET',
        severity: 'MEDIUM',
        message: `${formatMoney(budget, job.currency)} for a platform-scale build (${words} words of scope)`,
      };
    }
  }

  if (hourly !== null && hourly > 0) {
    if (hourly < 3) {
      return {
        code: 'UNREALISTIC_BUDGET',
        severity: 'HIGH',
        message: `posted rate of ${formatMoney(hourly, job.currency)}/hr is below any sustainable floor`,
      };
    }
    if (hourly < 6) {
      return {
        code: 'UNREALISTIC_BUDGET',
        severity: 'MEDIUM',
        message: `posted rate of ${formatMoney(hourly, job.currency)}/hr is a race to the bottom`,
      };
    }
  }

  return null;
}

function excessiveScopeForRate(job: ScorableJob): RedFlag | null {
  const hourly = effectiveHourlyRate(job);
  if (hourly === null || hourly > 20) return null;

  const bullets = bulletCount(job.description ?? '');
  const words = wordCount(job.description ?? '');
  if (bullets >= 10 || words >= 900) {
    return {
      code: 'SCOPE_VS_RATE',
      severity: 'MEDIUM',
      message: `${bullets >= 10 ? `${bullets} listed deliverables` : `${words} words of scope`} capped at ${formatMoney(hourly, job.currency)}/hr`,
    };
  }
  return null;
}

function boilerplateSpec(job: ScorableJob): RedFlag | null {
  const description = normalizeText(job.description);
  if (description === '') {
    return {
      code: 'BOILERPLATE_SPEC',
      severity: 'MEDIUM',
      message: 'the posting has no description at all',
    };
  }

  const sentences = description
    .split(/[.!?\n]+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length >= 25);
  const seen = new Map<string, number>();
  for (const sentence of sentences) {
    seen.set(sentence, (seen.get(sentence) ?? 0) + 1);
  }
  for (const [sentence, count] of seen) {
    if (count >= 3) {
      return {
        code: 'BOILERPLATE_SPEC',
        severity: 'MEDIUM',
        message: `the same sentence is repeated ${count} times ("${truncate(sentence, 60)}")`,
      };
    }
  }

  const hits = BOILERPLATE_PHRASES.filter((phrase) => description.includes(phrase));
  if (hits.length >= 3 || (hits.length >= 2 && description.length < 700)) {
    return {
      code: 'BOILERPLATE_SPEC',
      severity: 'LOW',
      message: `reads as a copy-paste template (${hits.length} stock phrases, e.g. "${hits[0]}")`,
    };
  }

  return null;
}

function newClientHighBudget(job: ScorableJob): RedFlag | null {
  const budget = isKnownNumber(job.budgetAmount) ? job.budgetAmount : null;
  if (budget === null || budget < 1000) return null;

  const hires = job.clientTotalHires;
  const spent = job.clientTotalSpent;
  const zeroHistory = hires === 0 && (spent === 0 || spent === null || spent === undefined);

  const memberSince = toDate(job.clientMemberSince);
  const accountAgeDays =
    memberSince === null ? null : (Date.now() - memberSince.getTime()) / (24 * 60 * 60 * 1000);
  const brandNewAccount = accountAgeDays !== null && accountAgeDays <= 14;

  if (!zeroHistory && !brandNewAccount) return null;
  if (budget < 3000 && !brandNewAccount) return null;

  const unverified = job.clientPaymentVerified === false;
  const parts: string[] = [];
  if (zeroHistory) parts.push('no hires and no spend on record');
  if (brandNewAccount) parts.push(`account is ${Math.max(0, Math.round(accountAgeDays ?? 0))} days old`);
  if (unverified) parts.push('payment method unverified');

  return {
    code: 'NEW_CLIENT_HIGH_BUDGET',
    severity: unverified ? 'HIGH' : 'MEDIUM',
    message: `${formatMoney(budget, job.currency)} posted by a client with ${parts.join(', ')}`,
  };
}

function shoutingOrUrgency(job: ScorableJob): RedFlag | null {
  const title = job.title ?? '';
  const ratio = upperCaseRatio(title);
  if (ratio > 0.6 && title.trim().length >= 12) {
    return {
      code: 'SHOUTING_TITLE',
      severity: 'LOW',
      message: `title is ${Math.round(ratio * 100)}% upper case ("${truncate(title, 60)}")`,
    };
  }

  const text = `${title} ${job.description ?? ''}`;
  const urgency = /\b(?:urgent!|urgently|asap|immediately|right now|start today|hiring now)\b/i;
  if (/!{3,}/.test(text) || (urgency.test(text) && /!{2,}/.test(text))) {
    return {
      code: 'URGENCY_SPAM',
      severity: 'LOW',
      message: 'urgency and exclamation-mark spam in the posting',
    };
  }

  return null;
}

const STRUCTURAL_CHECKS: ((job: ScorableJob) => RedFlag | null)[] = [
  unrealisticBudget,
  excessiveScopeForRate,
  boilerplateSpec,
  newClientHighBudget,
  shoutingOrUrgency,
];

/**
 * Everything suspicious about a posting, most severe first. Pure and cheap:
 * a handful of regexes over the normalised text plus structural checks.
 */
export function detectRedFlags(job: ScorableJob): RedFlag[] {
  const text = jobText(job);
  const flags: RedFlag[] = [];
  const seen = new Set<string>();

  for (const rule of PATTERN_RULES) {
    const haystack =
      rule.scope === 'title' ? text.title : rule.scope === 'description' ? text.description : text.all;
    const evidence = findEvidence(haystack, rule.patterns);
    if (evidence === null || seen.has(rule.code)) continue;
    seen.add(rule.code);
    flags.push({ code: rule.code, severity: rule.severity, message: rule.describe(evidence) });
  }

  for (const check of STRUCTURAL_CHECKS) {
    const flag = check(job);
    if (flag && !seen.has(flag.code)) {
      seen.add(flag.code);
      flags.push(flag);
    }
  }

  const order: Record<RedFlagSeverity, number> = { HIGH: 0, MEDIUM: 1, LOW: 2 };
  return flags.sort((a, b) => order[a.severity] - order[b.severity]);
}

export function hasVetoFlag(flags: RedFlag[]): boolean {
  return flags.some((flag) => flag.severity === 'HIGH');
}

/**
 * Points to subtract from the rule score. A single HIGH flag returns a full
 * 100-point penalty (a veto, the job cannot be bid on); MEDIUM and LOW flags
 * accumulate at 15 and 5 points and are capped at MAX_SOFT_PENALTY together.
 */
export function redFlagPenalty(flags: RedFlag[]): number {
  if (hasVetoFlag(flags)) return RED_FLAG_PENALTIES.HIGH;
  const soft = flags.reduce((total, flag) => total + (RED_FLAG_PENALTIES[flag.severity] ?? 0), 0);
  return Math.min(MAX_SOFT_PENALTY, soft);
}

/** One-line summaries for the reasons array and the dashboard. */
export function describeRedFlags(flags: RedFlag[]): string[] {
  return flags.map((flag) => `${flag.severity} red flag: ${flag.message}`);
}

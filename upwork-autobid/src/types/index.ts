/**
 * Shared domain contract for UpBid. Every module (sources, scoring, drafting,
 * submitters, notifiers, server) builds against these types.
 */

export type JobType = 'HOURLY' | 'FIXED' | 'UNKNOWN';

export type ExperienceLevel = 'ENTRY' | 'INTERMEDIATE' | 'EXPERT';

export type Decision = 'BID' | 'REVIEW' | 'SKIP';

export type JobStatus =
  | 'NEW'
  | 'SCORED'
  | 'DRAFTED'
  | 'QUEUED'
  | 'SUBMITTED'
  | 'SKIPPED'
  | 'EXPIRED';

export type ProposalStatus =
  | 'DRAFT'
  | 'PENDING_APPROVAL'
  | 'APPROVED'
  | 'REJECTED'
  | 'SUBMITTING'
  | 'SUBMITTED'
  | 'FAILED'
  | 'EXPIRED';

export type SubmissionStatus =
  | 'SUBMITTED'
  | 'QUEUED_FOR_REVIEW'
  | 'FAILED'
  | 'SKIPPED'
  | 'DRY_RUN';

export const JOB_STATUS: readonly JobStatus[] = [
  'NEW',
  'SCORED',
  'DRAFTED',
  'QUEUED',
  'SUBMITTED',
  'SKIPPED',
  'EXPIRED',
] as const;

export const PROPOSAL_STATUS: readonly ProposalStatus[] = [
  'DRAFT',
  'PENDING_APPROVAL',
  'APPROVED',
  'REJECTED',
  'SUBMITTING',
  'SUBMITTED',
  'FAILED',
  'EXPIRED',
] as const;

export const SUBMISSION_STATUS: readonly SubmissionStatus[] = [
  'SUBMITTED',
  'QUEUED_FOR_REVIEW',
  'FAILED',
  'SKIPPED',
  'DRY_RUN',
] as const;

export function isJobStatus(value: string): value is JobStatus {
  return (JOB_STATUS as readonly string[]).includes(value);
}

export function isProposalStatus(value: string): value is ProposalStatus {
  return (PROPOSAL_STATUS as readonly string[]).includes(value);
}

export function isSubmissionStatus(value: string): value is SubmissionStatus {
  return (SUBMISSION_STATUS as readonly string[]).includes(value);
}

/* ---------------------------------------------------------------- ingestion */

export interface ClientInfo {
  country: string | null;
  city: string | null;
  paymentVerified: boolean | null;
  totalSpent: number | null;
  totalHires: number | null;
  hireRate: number | null;
  avgRating: number | null;
  reviewsCount: number | null;
  memberSince: Date | null;
  openJobs: number | null;
  /** Stable client identifier when the source exposes one; used for blocklists. */
  clientId?: string | null;
  companyName?: string | null;
}

export function emptyClientInfo(): ClientInfo {
  return {
    country: null,
    city: null,
    paymentVerified: null,
    totalSpent: null,
    totalHires: null,
    hireRate: null,
    avgRating: null,
    reviewsCount: null,
    memberSince: null,
    openJobs: null,
    clientId: null,
    companyName: null,
  };
}

/** A job as returned by a source, before persistence. */
export interface RawJob {
  source: string;
  externalId: string;
  url: string;
  title: string;
  description: string;
  postedAt: Date | null;
  skills: string[];
  category: string | null;
  subcategory: string | null;
  jobType: JobType;
  budgetAmount: number | null;
  hourlyMin: number | null;
  hourlyMax: number | null;
  currency: string | null;
  durationLabel: string | null;
  experienceLevel: string | null;
  workload: string | null;
  connectsRequired: number | null;
  proposalsCount: number | null;
  interviewingCount: number | null;
  screeningQuestions: string[];
  client: ClientInfo;
  raw?: unknown;
}

export interface SourceContext {
  profileId: string;
  profileName: string;
  queries: string[];
  since: Date | null;
  cursor: string | null;
  limit: number;
}

export interface SourceResult {
  jobs: RawJob[];
  cursor: string | null;
  meta?: Record<string, unknown>;
}

export interface JobSource {
  readonly name: string;
  isEnabled(): boolean;
  fetch(ctx: SourceContext): Promise<SourceResult>;
}

/* ------------------------------------------------------------------ scoring */

export interface ScoreBreakdownItem {
  key: string;
  label: string;
  points: number;
  max: number;
  detail: string;
}

export type RedFlagSeverity = 'LOW' | 'MEDIUM' | 'HIGH';

export interface RedFlag {
  code: string;
  severity: RedFlagSeverity;
  message: string;
}

export interface ScoreResult {
  score: number;
  decision: Decision;
  breakdown: ScoreBreakdownItem[];
  redFlags: RedFlag[];
  reasons: string[];
  matchedKeywords: string[];
  matchedSkills: string[];
  /** Non-empty means a hard filter rejected the job; decision is always SKIP. */
  hardFilterFailures: string[];
  llmScore?: number | null;
  llmRationale?: string | null;
}

/** Relative weights per scoring dimension. Points are normalised against the sum. */
export interface ScoringWeights {
  keywordMatch: number;
  skillMatch: number;
  budgetFit: number;
  clientQuality: number;
  competition: number;
  freshness: number;
  descriptionQuality: number;
  categoryFit: number;
  experienceFit: number;
  llmRerank: number;
}

export const DEFAULT_WEIGHTS: ScoringWeights = {
  keywordMatch: 18,
  skillMatch: 18,
  budgetFit: 14,
  clientQuality: 16,
  competition: 10,
  freshness: 8,
  descriptionQuality: 6,
  categoryFit: 5,
  experienceFit: 5,
  llmRerank: 20,
};

export const SCORING_WEIGHT_KEYS: readonly (keyof ScoringWeights)[] = [
  'keywordMatch',
  'skillMatch',
  'budgetFit',
  'clientQuality',
  'competition',
  'freshness',
  'descriptionQuality',
  'categoryFit',
  'experienceFit',
  'llmRerank',
] as const;

/** Merges a partial (per-profile) override over DEFAULT_WEIGHTS, ignoring junk values. */
export function resolveWeights(override: unknown): ScoringWeights {
  const merged: ScoringWeights = { ...DEFAULT_WEIGHTS };
  if (!override || typeof override !== 'object' || Array.isArray(override)) return merged;
  const candidate = override as Record<string, unknown>;
  for (const key of SCORING_WEIGHT_KEYS) {
    const value = candidate[key];
    if (typeof value === 'number' && Number.isFinite(value) && value >= 0) {
      merged[key] = value;
    }
  }
  return merged;
}

/* ----------------------------------------------------------------- drafting */

export interface QuestionAnswer {
  question: string;
  answer: string;
}

export interface DraftProposal {
  coverLetter: string;
  bidAmount: number | null;
  hourlyRate: number | null;
  estimatedDurationLabel: string | null;
  questionAnswers: QuestionAnswer[];
  model: string;
  promptTokens?: number;
  completionTokens?: number;
  warnings: string[];
  generationMs: number;
}

/* --------------------------------------------------------------- submission */

/**
 * Minimal shapes the submitters need. Deliberately structural (not Prisma types)
 * so submitters stay testable without a database.
 */
export interface SubmitProfileView {
  id: string;
  name: string;
  autoSubmit: boolean;
  hourlyRate: number | null;
  maxDailySubmissions: number;
  maxHourlySubmissions: number;
  maxDailyConnects: number;
}

export interface SubmitJobView {
  id: string;
  source: string;
  externalId: string;
  url: string;
  title: string;
  jobType: JobType | string;
  connectsRequired: number | null;
  budgetAmount: number | null;
}

export interface SubmitContext {
  proposalId: string;
  profile: SubmitProfileView;
  job: SubmitJobView;
  coverLetter: string;
  bidAmount: number | null;
  hourlyRate: number | null;
  questionAnswers: QuestionAnswer[];
  dryRun: boolean;
}

export interface SubmitResult {
  status: SubmissionStatus;
  externalRef?: string;
  message: string;
  connectsSpent?: number;
}

export interface ProposalSubmitter {
  readonly name: string;
  /** False for the review queue: it never submits without a human tap. */
  readonly canAutoSubmit: boolean;
  isConfigured(): boolean;
  submit(ctx: SubmitContext): Promise<SubmitResult>;
}

/* ------------------------------------------------------------ notifications */

export interface NotificationAction {
  label: string;
  url: string;
}

export interface NotificationMessage {
  subject: string;
  body: string;
  html?: string;
  url?: string;
  actions?: NotificationAction[];
  refType?: string;
  refId?: string;
  urgent?: boolean;
}

export interface NotificationChannel {
  readonly name: string;
  isConfigured(): boolean;
  send(msg: NotificationMessage): Promise<void>;
}

/* ---------------------------------------------------------------- job queue */

export interface PollJobData {
  profileId: string;
  source?: string;
  reason?: string;
}

export interface ScoreJobData {
  jobId: string;
  profileId: string;
}

export interface DraftJobData {
  jobId: string;
  profileId: string;
  matchId?: string;
}

export interface SubmitJobData {
  proposalId: string;
  approvedBy?: string;
}

export interface NotifyJobData {
  channel?: string;
  message: NotificationMessage;
}

/* ----------------------------------------------------------------- reporting */

export interface HealthReport {
  ok: boolean;
  uptimeSeconds: number;
  version: string;
  checks: Record<string, { ok: boolean; detail?: string; latencyMs?: number }>;
  components: { component: string; lastBeatAt: string; status: string; detail: string | null }[];
}

export interface PipelineStats {
  jobsSeen24h: number;
  jobsScored24h: number;
  proposalsDrafted24h: number;
  submitted24h: number;
  pendingApproval: number;
  avgScore24h: number | null;
}

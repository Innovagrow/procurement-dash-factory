import { describe, expect, it } from 'vitest';
import { findUnresolvedPlaceholders, stripContacts, validateProposal } from '../src/proposals/guardrails';
import { makeJob, makeDraftProfile } from './fixtures';

const GOOD_LETTER = [
  'Your pipeline problem is the ordering guarantee rather than raw throughput, and that is',
  'where these builds usually break under a consumer rebalance.',
  '',
  'I have shipped this topology twice: a TypeScript consumer group writing into PostgreSQL',
  'with an idempotent upsert keyed on event id and revision, so a replay after a rebalance',
  'is a no-op instead of a double count.',
  '',
  'I would start with two days mapping your topics and retention, then a thin vertical slice',
  'end to end with backfill tested, then roll the rest out behind a flag with lag on a dashboard.',
  '',
  'One question: are you replaying history on cutover, or starting from the current offset?',
].join('\n');

const draft = (over: Record<string, unknown> = {}) => ({
  coverLetter: GOOD_LETTER,
  bidAmount: null,
  hourlyRate: 70,
  estimatedDurationLabel: '6 weeks',
  questionAnswers: [],
  currency: 'USD',
  ...over,
});

describe('validateProposal', () => {
  it('accepts a clean, specific proposal', () => {
    const result = validateProposal(draft(), makeJob(), makeDraftProfile());
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('rejects an unresolved template placeholder', () => {
    const result = validateProposal(
      draft({ coverLetter: GOOD_LETTER + '\n\nBest regards, {{name}}' }),
      makeJob(), makeDraftProfile(),
    );
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ').toLowerCase()).toMatch(/placeholder|\{\{/);
  });

  it('rejects a cover letter that is too short to be a real proposal', () => {
    const result = validateProposal(draft({ coverLetter: 'I can do this job.' }), makeJob(), makeDraftProfile());
    expect(result.ok).toBe(false);
  });

  it('flags a letter over the profile character limit', () => {
    const result = validateProposal(
      draft({ coverLetter: GOOD_LETTER + ' '.repeat(10) + 'x'.repeat(4000) }),
      makeJob(), makeDraftProfile({ proposalMaxChars: 1500 }),
    );
    expect([...result.errors, ...result.warnings].join(' ').toLowerCase())
      .toMatch(/length|characters|too long|limit/);
  });

  it('catches a banned tell-tale phrase', () => {
    const result = validateProposal(
      draft({ coverLetter: 'As an AI language model, I can help. ' + GOOD_LETTER }),
      makeJob(), makeDraftProfile(),
    );
    expect([...result.errors, ...result.warnings].length).toBeGreaterThan(0);
  });

  it('catches contact details and off-platform solicitation', () => {
    const result = validateProposal(
      draft({ coverLetter: GOOD_LETTER + '\n\nEmail me at me@example.com or on Telegram @handle.' }),
      makeJob(), makeDraftProfile(),
    );
    expect([...result.errors, ...result.warnings].join(' ').toLowerCase())
      .toMatch(/contact|email|telegram|off-platform|off platform/);
  });

  it('requires an answer to every screening question', () => {
    const job = makeJob({ screeningQuestions: ['How many years of Kafka experience do you have?'] });
    const result = validateProposal(draft({ questionAnswers: [] }), job, makeDraftProfile());
    expect([...result.errors, ...result.warnings].join(' ').toLowerCase()).toMatch(/question|answer/);
  });
});

describe('stripContacts', () => {
  it('removes an email address from otherwise good text', () => {
    const out = stripContacts('Reach me at someone@example.com any time.');
    expect(out.text).not.toContain('someone@example.com');
  });
});

describe('findUnresolvedPlaceholders', () => {
  it('finds every unfilled slot and none in clean text', () => {
    expect(findUnresolvedPlaceholders('Hi {{name}}, about {{project}}.')).toHaveLength(2);
    expect(findUnresolvedPlaceholders('Hi there, about your pipeline.')).toHaveLength(0);
  });
});

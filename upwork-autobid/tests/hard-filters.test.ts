import { describe, expect, it } from 'vitest';
import { applyHardFilters, passesHardFilters } from '../src/scoring/hard-filters';
import { makeJob, makeProfile } from './fixtures';

const joined = (job = makeJob(), profile = makeProfile()) =>
  applyHardFilters(job, profile).join(' | ').toLowerCase();

describe('applyHardFilters', () => {
  it('passes a job that satisfies every filter', () => {
    expect(applyHardFilters(makeJob(), makeProfile())).toEqual([]);
    expect(passesHardFilters(makeJob(), makeProfile())).toBe(true);
  });

  it('rejects an excluded keyword', () => {
    expect(joined(makeJob({ title: 'WordPress theme fix needed' }))).toContain('wordpress');
  });

  it('rejects a job missing a required skill', () => {
    expect(joined(makeJob({ skills: ['PHP'], title: 'Build a thing', description: 'A thing.' })))
      .toMatch(/skill/);
  });

  it('rejects a disallowed job type', () => {
    expect(joined(makeJob(), makeProfile({ jobTypes: ['FIXED'] }))).toMatch(/type/);
  });

  it('rejects a disallowed experience level', () => {
    expect(joined(makeJob({ experienceLevel: 'ENTRY' }))).toMatch(/experience|level/);
  });

  it('rejects a fixed budget under the floor', () => {
    const job = makeJob({ jobType: 'FIXED', budgetAmount: 60, hourlyMin: null, hourlyMax: null });
    expect(joined(job)).toMatch(/budget|60/);
  });

  it('rejects an hourly ceiling under the rate floor', () => {
    expect(joined(makeJob({ hourlyMin: 10, hourlyMax: 20 }))).toMatch(/rate|hourly/);
  });

  it('rejects a job with too many proposals', () => {
    expect(joined(makeJob({ proposalsCount: 40 }))).toMatch(/proposal/);
  });

  it('rejects a job older than the age limit', () => {
    expect(joined(makeJob({ postedAt: new Date(Date.now() - 600 * 60_000) }))).toMatch(/freshness|limit|posted/);
  });

  it('rejects an unverified client when verification is required', () => {
    expect(joined(makeJob({ clientPaymentVerified: false }))).toMatch(/verif/);
  });

  it('rejects a client below the spend floor', () => {
    expect(joined(makeJob({ clientTotalSpent: 10 }))).toMatch(/spent|spend/);
  });

  it('rejects a client below the rating floor', () => {
    expect(joined(makeJob({ clientAvgRating: 2.1 }))).toMatch(/rating/);
  });

  it('rejects a client below the hire-rate floor', () => {
    expect(joined(makeJob({ clientHireRate: 0.05 }))).toMatch(/hire/);
  });

  it('rejects a blocked country and accepts an allowed one', () => {
    expect(joined(makeJob(), makeProfile({ blockedCountries: ['United States'] })))
      .toMatch(/countr/);
    expect(applyHardFilters(makeJob(), makeProfile({ allowedCountries: ['United States'] })))
      .toEqual([]);
  });

  it('rejects a country outside an allow list', () => {
    expect(joined(makeJob(), makeProfile({ allowedCountries: ['Germany'] }))).toMatch(/countr/);
  });
});

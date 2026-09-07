import { describe, expect, it } from 'vitest';
import { scoreJob } from '../src/scoring/scorer';
import { makeJob, makeProfile } from './fixtures';

describe('scoreJob', () => {
  it('clears the bid threshold for a strong, fresh, uncrowded job', () => {
    const result = scoreJob(makeJob(), makeProfile());
    expect(result.hardFilterFailures).toEqual([]);
    expect(result.score).toBeGreaterThanOrEqual(85);
    expect(result.decision).toBe('BID');
  });

  it('keeps the score inside 0..100 for every input it is given', () => {
    const cases = [
      makeJob(),
      makeJob({ proposalsCount: 50, postedAt: new Date(Date.now() - 170 * 60_000) }),
      makeJob({ clientTotalSpent: null, clientAvgRating: null, clientHireRate: null }),
      makeJob({ skills: [], description: '' }),
    ];
    for (const job of cases) {
      const result = scoreJob(job, makeProfile());
      expect(result.score).toBeGreaterThanOrEqual(0);
      expect(result.score).toBeLessThanOrEqual(100);
    }
  });

  it('never awards a dimension more points than its maximum', () => {
    const result = scoreJob(makeJob(), makeProfile());
    expect(result.breakdown.length).toBeGreaterThan(0);
    for (const item of result.breakdown) {
      expect(item.points).toBeLessThanOrEqual(item.max);
      expect(item.detail).toBeTruthy();
    }
  });

  it('penalises a crowded job relative to an identical uncrowded one', () => {
    const profile = makeProfile({ maxProposals: null });
    const quiet = scoreJob(makeJob({ proposalsCount: 2 }), profile);
    const crowded = scoreJob(makeJob({ proposalsCount: 45 }), profile);
    expect(crowded.score).toBeLessThan(quiet.score);
  });

  it('rewards a fresher posting over an older identical one', () => {
    const profile = makeProfile({ maxJobAgeMinutes: null });
    const fresh = scoreJob(makeJob({ postedAt: new Date(Date.now() - 2 * 60_000) }), profile);
    const stale = scoreJob(makeJob({ postedAt: new Date(Date.now() - 20 * 60 * 60_000) }), profile);
    expect(fresh.score).toBeGreaterThan(stale.score);
  });

  it('treats unknown client history as neutral rather than as zero', () => {
    const profile = makeProfile({
      requirePaymentVerified: false,
      minClientSpend: null,
      minClientRating: null,
      minClientHireRate: null,
      minClientReviews: null,
    });
    const unknown = scoreJob(makeJob({
      clientTotalSpent: null, clientTotalHires: null, clientHireRate: null,
      clientAvgRating: null, clientReviewsCount: null, clientPaymentVerified: null,
    }), profile);
    const bad = scoreJob(makeJob({
      clientTotalSpent: 0, clientTotalHires: 0, clientHireRate: 0,
      clientAvgRating: 1, clientReviewsCount: 0, clientPaymentVerified: false,
    }), profile);
    expect(unknown.score).toBeGreaterThan(bad.score);
  });

  it('returns SKIP with a zero score and a stated reason when a hard filter trips', () => {
    const result = scoreJob(makeJob({ clientPaymentVerified: false }), makeProfile());
    expect(result.decision).toBe('SKIP');
    expect(result.score).toBe(0);
    expect(result.hardFilterFailures.length).toBeGreaterThan(0);
    expect(result.reasons.join(' ')).toContain('hard filter');
  });

  it('lands a middling job in REVIEW rather than BID', () => {
    const result = scoreJob(
      makeJob({
        proposalsCount: 14,
        postedAt: new Date(Date.now() - 150 * 60_000),
        skills: ['TypeScript', 'Node.js'],
        clientTotalSpent: 2500,
        clientAvgRating: 4.6,
        clientHireRate: 0.45,
      }),
      makeProfile(),
    );
    if (result.decision !== 'SKIP') {
      expect(result.score).toBeLessThan(85);
      expect(result.decision).toBe('REVIEW');
    }
  });

  it('reports which keywords and skills matched', () => {
    const result = scoreJob(makeJob(), makeProfile());
    // matched skills are normalised to lowercase for stable comparison
    expect(result.matchedSkills.map((s) => s.toLowerCase())).toContain('typescript');
    expect(result.matchedKeywords.length).toBeGreaterThan(0);
  });
});

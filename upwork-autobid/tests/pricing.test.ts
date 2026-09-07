import { describe, expect, it } from 'vitest';
import { computeBid, estimateConnects, roundBid, roundRate } from '../src/proposals/pricing';
import { makeJob, makeDraftProfile } from './fixtures';

const fixedJob = (budget: number) =>
  makeJob({ jobType: 'FIXED', budgetAmount: budget, hourlyMin: null, hourlyMax: null });

describe('computeBid', () => {
  it('bids a percentage of the posted budget under PERCENT_OF_BUDGET', () => {
    const bid = computeBid(fixedJob(2000), makeDraftProfile({
      fixedBidStrategy: 'PERCENT_OF_BUDGET', fixedBidPercent: 0.9,
    }));
    expect(bid.bidAmount).not.toBeNull();
    expect(bid.bidAmount!).toBeGreaterThan(1500);
    expect(bid.bidAmount!).toBeLessThanOrEqual(2000);
  });

  it('clamps a fixed bid up to the profile minimum', () => {
    const bid = computeBid(fixedJob(300), makeDraftProfile({ minBid: 900, maxBid: 15000 }));
    expect(bid.bidAmount!).toBeGreaterThanOrEqual(900);
  });

  it('clamps a fixed bid down to the profile maximum', () => {
    const bid = computeBid(fixedJob(90000), makeDraftProfile({ minBid: 500, maxBid: 8000 }));
    expect(bid.bidAmount!).toBeLessThanOrEqual(8000);
  });

  it('keeps an hourly rate inside the range the client posted', () => {
    const bid = computeBid(makeJob({ hourlyMin: 40, hourlyMax: 70 }), makeDraftProfile({ hourlyRate: 45 }));
    expect(bid.hourlyRate).not.toBeNull();
    expect(bid.hourlyRate!).toBeLessThanOrEqual(70);
    expect(bid.hourlyRate!).toBeGreaterThanOrEqual(40);
  });

  it('never proposes an hourly rate below the profile floor', () => {
    const bid = computeBid(makeJob({ hourlyMin: 20, hourlyMax: 95 }), makeDraftProfile({ hourlyRate: 65 }));
    expect(bid.hourlyRate!).toBeGreaterThanOrEqual(65);
  });

  it('produces a duration label and a connects cost for every job', () => {
    const bid = computeBid(makeJob(), makeDraftProfile());
    expect(bid.estimatedDurationLabel).toBeTruthy();
    expect(bid.connectsCost).toBeGreaterThan(0);
    expect(bid.rationale).toBeTruthy();
  });

  it('honours the FLAT strategy independently of the posted budget', () => {
    const low = computeBid(fixedJob(1000), makeDraftProfile({ fixedBidStrategy: 'FLAT', minBid: 2000, maxBid: 2000 }));
    const high = computeBid(fixedJob(9000), makeDraftProfile({ fixedBidStrategy: 'FLAT', minBid: 2000, maxBid: 2000 }));
    expect(low.bidAmount).toBe(high.bidAmount);
  });
});

describe('rounding helpers', () => {
  it('rounds bids to a clean number and respects bounds', () => {
    expect(roundBid(2137, 500, 15000) % 5).toBe(0);
    expect(roundBid(120, 500, 15000)).toBeGreaterThanOrEqual(500);
    expect(roundBid(99999, 500, 8000)).toBeLessThanOrEqual(8000);
  });

  it('keeps a rounded rate within its floor and ceiling', () => {
    expect(roundRate(63.7, 50, 90)).toBeGreaterThanOrEqual(50);
    expect(roundRate(200, 50, 90)).toBeLessThanOrEqual(90);
  });
});

describe('estimateConnects', () => {
  it('uses the value the job states when present', () => {
    expect(estimateConnects(makeJob({ connectsRequired: 12 }))).toBe(12);
  });

  it('falls back to a bounded estimate when the job does not say', () => {
    const n = estimateConnects(makeJob({ connectsRequired: null }));
    expect(n).toBeGreaterThan(0);
    expect(n).toBeLessThanOrEqual(16);
  });
});

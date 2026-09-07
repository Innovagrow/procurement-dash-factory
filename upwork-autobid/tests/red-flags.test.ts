import { describe, expect, it } from 'vitest';
import { detectRedFlags, hasVetoFlag, redFlagPenalty } from '../src/scoring/red-flags';
import { makeJob } from './fixtures';

const codes = (job = makeJob()) => detectRedFlags(job).map((f) => f.code).join(' ');

describe('detectRedFlags', () => {
  it('finds nothing wrong with a clean job', () => {
    expect(detectRedFlags(makeJob())).toEqual([]);
    expect(hasVetoFlag([])).toBe(false);
    expect(redFlagPenalty([])).toBe(0);
  });

  it('detects a request to move payment off the platform', () => {
    const flags = detectRedFlags(makeJob({
      description: 'Please contact me on Telegram and we will pay outside Upwork directly.',
    }));
    expect(flags.length).toBeGreaterThan(0);
    expect(hasVetoFlag(flags)).toBe(true);
  });

  it('detects an unpaid test request', () => {
    expect(codes(makeJob({
      description: 'First complete a free test task so we can assess your skills, unpaid sample required.',
    }))).toBeTruthy();
  });

  it('detects a credential request', () => {
    const flags = detectRedFlags(makeJob({
      description: 'You will need to send your login and password for our account to get started.',
    }));
    expect(flags.length).toBeGreaterThan(0);
  });

  it('assigns a heavier penalty to more severe findings', () => {
    const clean = redFlagPenalty([]);
    const dirty = redFlagPenalty(detectRedFlags(makeJob({
      description: 'Pay via crypto on WhatsApp, send your password, free sample first.',
    })));
    expect(dirty).toBeGreaterThan(clean);
  });

  it('never returns a flag without a code, severity and message', () => {
    const flags = detectRedFlags(makeJob({
      description: 'URGENT!!! Contact me on skype, pay outside upwork, free trial task first.',
    }));
    for (const flag of flags) {
      expect(flag.code).toBeTruthy();
      expect(['LOW', 'MEDIUM', 'HIGH']).toContain(flag.severity);
      expect(flag.message).toBeTruthy();
    }
  });
});

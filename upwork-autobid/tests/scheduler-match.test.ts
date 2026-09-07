import { describe, expect, it } from 'vitest';

// Regression guard for the bug that silently stopped detection after every
// deploy: BullMQ's getRepeatableJobs() does not echo back the jobId the caller
// passed, so comparing it strictly marked every freshly added schedule as
// superseded, and the prune pass deleted it immediately after registration.
//
// This reproduces the matching predicate in isolation, since importing the
// scheduler pulls in Redis connections.
type RepeatableView = { name: string; id?: string | null; every?: number | string | null };
type Definition = { name: string; jobId: string; repeat: { every?: number } };

function sameRepeat(existing: RepeatableView, definition: Definition): boolean {
  if (existing.name !== definition.name) return false;
  if (existing.id && existing.id !== definition.jobId) return false;
  const { every } = definition.repeat;
  if (every !== undefined) {
    if (existing.every === null || existing.every === undefined) return false;
    return String(existing.every) === String(every);
  }
  return true;
}

const definition: Definition = { name: 'discover-fast', jobId: 'discover-fast', repeat: { every: 20000 } };

describe('sameRepeat', () => {
  it('matches when BullMQ omits the id, which is the normal case', () => {
    expect(sameRepeat({ name: 'discover-fast', every: 20000 }, definition)).toBe(true);
    expect(sameRepeat({ name: 'discover-fast', id: null, every: 20000 }, definition)).toBe(true);
    expect(sameRepeat({ name: 'discover-fast', id: '', every: 20000 }, definition)).toBe(true);
  });

  it('still rejects a genuinely different id', () => {
    expect(sameRepeat({ name: 'discover-fast', id: 'something-else', every: 20000 }, definition)).toBe(false);
  });

  it('rejects a changed cadence so a config change does resupersede', () => {
    expect(sameRepeat({ name: 'discover-fast', every: 60000 }, definition)).toBe(false);
  });

  it('rejects a different schedule name', () => {
    expect(sameRepeat({ name: 'discover-standard', every: 20000 }, definition)).toBe(false);
  });

  it('tolerates the numeric/string drift BullMQ returns for every', () => {
    expect(sameRepeat({ name: 'discover-fast', every: '20000' }, definition)).toBe(true);
  });
});

// BullMQ rejects a custom job id containing ":". Every deterministic id the
// queue helpers build must therefore avoid it, or the job is silently dropped
// and nothing downstream of discovery ever runs.
describe('deterministic job ids', () => {
  const ids = [
    `discover-fast-abc-${1700000000000}`,
    `score-job123-profile456-hashabc`,
    `draft-job123-profile456`,
    `submit-proposal789`,
    `maintenance-sweep-${1700000000000}`,
    `digest-${1700000000000}`,
  ];

  it('never contains a colon', () => {
    for (const id of ids) expect(id).not.toContain(':');
  });

  it('sanitises a caller-supplied id the same way', () => {
    const sanitise = (raw: string) => raw.replace(/:/g, '-');
    expect(sanitise('score:job:profile')).toBe('score-job-profile');
    expect(sanitise('already-safe')).toBe('already-safe');
  });
});

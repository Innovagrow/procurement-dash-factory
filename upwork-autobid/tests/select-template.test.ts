import { beforeEach, describe, expect, it, vi } from 'vitest';
import { makeDraftProfile, makeJob } from './fixtures';

/**
 * templates.ts resolves prisma and the logger lazily, so the selector can be
 * exercised against a fake table without a database, a redis or an environment.
 */
const findMany = vi.fn();
const updateMany = vi.fn(async () => ({ count: 1 }));
const warn = vi.fn();

vi.mock('../src/lib/prisma', () => ({
  prisma: { template: { findMany, updateMany } },
}));

vi.mock('../src/lib/logger', () => ({
  child: () => ({ warn, info: vi.fn(), debug: vi.fn(), error: vi.fn(), trace: vi.fn() }),
}));

import {
  invalidateTemplateCache,
  loadDbTemplates,
  recordTemplateUse,
  selectTemplate,
} from '../src/proposals/templates';

interface RowOverrides {
  id?: string;
  name?: string;
  jobTypes?: string[];
  tone?: string;
  categories?: string[];
  minScore?: number | null;
  body?: string;
  variables?: string[];
  isDefault?: boolean;
  timesUsed?: number;
  lastUsedAt?: Date | null;
}

/** A Template row as Prisma would hand it back. */
function row(overrides: RowOverrides = {}): Record<string, unknown> {
  return {
    id: 'tpl_1',
    name: 'Stored template',
    description: null,
    jobTypes: [],
    tone: 'professional',
    categories: [],
    minScore: null,
    body: 'Hello {{focus}}',
    variables: ['focus'],
    notes: null,
    isDefault: false,
    isActive: true,
    timesUsed: 0,
    lastUsedAt: null,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const job = makeJob({
  jobType: 'HOURLY',
  category: 'Web Development',
  subcategory: null,
});
const profile = makeDraftProfile();

beforeEach(() => {
  invalidateTemplateCache();
  findMany.mockReset();
  updateMany.mockClear();
  warn.mockClear();
  findMany.mockResolvedValue([]);
});

describe('selectTemplate with an empty table', () => {
  it('falls back to the built-in library', async () => {
    const selected = await selectTemplate(job, profile);

    expect(selected.source).toBe('builtin');
    expect(selected.body).toContain('{{');
    expect(selected.variables.length).toBeGreaterThan(0);
  });

  it('falls back to a built-in when the query fails, without throwing', async () => {
    findMany.mockRejectedValue(new Error('connection terminated'));

    const selected = await selectTemplate(job, profile);

    expect(selected.source).toBe('builtin');
    expect(warn).toHaveBeenCalled();
  });
});

describe('selectTemplate ranking', () => {
  it('prefers the template that had to satisfy more constraints', async () => {
    findMany.mockResolvedValue([
      row({ id: 'general', name: 'General' }),
      row({ id: 'typed', name: 'Hourly only', jobTypes: ['HOURLY'] }),
      row({
        id: 'typed_and_categorised',
        name: 'Hourly web',
        jobTypes: ['HOURLY'],
        categories: ['Web Development'],
      }),
    ]);

    const selected = await selectTemplate(job, profile);

    expect(selected.source).toBe('db');
    expect(selected.id).toBe('typed_and_categorised');
    expect(selected.name).toBe('Hourly web');
  });

  it('breaks a tie on specificity with the operator default', async () => {
    findMany.mockResolvedValue([
      row({ id: 'plain_a', name: 'Plain A' }),
      row({ id: 'plain_b', name: 'Plain B', isDefault: true }),
      row({ id: 'plain_c', name: 'Plain C' }),
    ]);

    const selected = await selectTemplate(job, profile);

    expect(selected.id).toBe('plain_b');
  });

  it('does not let the default beat a more specific template', async () => {
    findMany.mockResolvedValue([
      row({ id: 'default_general', name: 'Default', isDefault: true }),
      row({ id: 'hourly', name: 'Hourly', jobTypes: ['HOURLY'] }),
    ]);

    expect((await selectTemplate(job, profile)).id).toBe('hourly');
  });

  it('rotates between equally eligible templates by least recent use', async () => {
    findMany.mockResolvedValue([
      row({ id: 'used_today', name: 'Used today', lastUsedAt: new Date('2026-09-07T00:00:00.000Z') }),
      row({ id: 'used_last_week', name: 'Used last week', lastUsedAt: new Date('2026-09-01T00:00:00.000Z') }),
      row({ id: 'never_used', name: 'Never used', lastUsedAt: null }),
    ]);

    expect((await selectTemplate(job, profile)).id).toBe('never_used');
  });

  it('skips a template whose job type does not match', async () => {
    findMany.mockResolvedValue([row({ id: 'fixed_only', jobTypes: ['FIXED'] })]);

    expect((await selectTemplate(job, profile)).source).toBe('builtin');
  });

  it('skips a category template the posting does not fall under', async () => {
    findMany.mockResolvedValue([row({ id: 'legal', categories: ['Legal Writing'] })]);

    expect((await selectTemplate(job, profile)).source).toBe('builtin');
  });

  it('matches a category the scorer would also accept', async () => {
    findMany.mockResolvedValue([row({ id: 'web', categories: ['web development'] })]);

    expect((await selectTemplate(job, profile)).id).toBe('web');
  });

  it('honours a minimum score floor in both directions', async () => {
    findMany.mockResolvedValue([row({ id: 'high_score_only', minScore: 80 })]);

    expect((await selectTemplate(job, profile, 90)).id).toBe('high_score_only');
    expect((await selectTemplate(job, profile, 70)).source).toBe('builtin');
    // An unscored draft cannot clear a floor, so the template is skipped.
    expect((await selectTemplate(job, profile, null)).source).toBe('builtin');
  });

  it('falls back to the operator default when nothing is eligible', async () => {
    findMany.mockResolvedValue([
      row({ id: 'fixed_only', jobTypes: ['FIXED'] }),
      row({ id: 'house_default', name: 'House default', jobTypes: ['FIXED'], isDefault: true }),
    ]);

    const selected = await selectTemplate(job, profile);

    expect(selected.source).toBe('db');
    expect(selected.id).toBe('house_default');
  });

  it('carries the stored body, declared variables and tone into the selection', async () => {
    findMany.mockResolvedValue([
      row({ id: 'voice', body: 'Hi - {{focus}} and {{priceLine}}', variables: [], tone: 'friendly' }),
    ]);

    const selected = await selectTemplate(job, profile);

    expect(selected.tone).toBe('friendly');
    expect(selected.body).toBe('Hi - {{focus}} and {{priceLine}}');
    // A row that declares nothing falls back to the slots its body uses.
    expect(selected.variables).toEqual(['focus', 'priceLine']);
  });
});

describe('the template cache', () => {
  it('reads the table once and serves the rest from memory', async () => {
    findMany.mockResolvedValue([row({ id: 'cached' })]);

    await selectTemplate(job, profile);
    await selectTemplate(job, profile);
    await loadDbTemplates();

    expect(findMany).toHaveBeenCalledTimes(1);
  });

  it('reloads after a dashboard write invalidates it', async () => {
    findMany.mockResolvedValue([row({ id: 'before' })]);
    expect((await selectTemplate(job, profile)).id).toBe('before');

    findMany.mockResolvedValue([row({ id: 'after' })]);
    expect((await selectTemplate(job, profile)).id).toBe('before');

    invalidateTemplateCache();
    expect((await selectTemplate(job, profile)).id).toBe('after');
    expect(findMany).toHaveBeenCalledTimes(2);
  });

  it('dedupes concurrent loads into one query', async () => {
    findMany.mockResolvedValue([row({ id: 'shared' })]);

    const [first, second] = await Promise.all([loadDbTemplates(), loadDbTemplates()]);

    expect(findMany).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe('recordTemplateUse', () => {
  it('stamps the row and rotates the cached copy so the next job differs', async () => {
    findMany.mockResolvedValue([row({ id: 'first' }), row({ id: 'second' })]);

    const one = await selectTemplate(job, profile);
    expect(one.id).toBe('first');

    recordTemplateUse(one.id as string);
    await vi.waitFor(() => expect(updateMany).toHaveBeenCalledTimes(1));

    expect(updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'first' } }),
    );
    expect((await selectTemplate(job, profile)).id).toBe('second');
  });

  it('ignores a blank id and never queries for one', () => {
    recordTemplateUse('   ');
    expect(updateMany).not.toHaveBeenCalled();
  });
});

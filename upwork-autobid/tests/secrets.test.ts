import { describe, expect, it, vi } from 'vitest';

// lib/secrets derives its key from API_KEY through config/env, which refuses to
// load at all without a database url. Hoisted so it runs before the import below.
vi.hoisted(() => {
  process.env.DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://user:pass@localhost:5432/upbid_test';
  process.env.API_KEY = process.env.API_KEY ?? 'test-api-key-0123456789';
});

import {
  decryptIfEncrypted,
  decryptSecret,
  encryptSecret,
  isEncrypted,
  isMasked,
  maskSecret,
} from '../src/lib/secrets';

const PASSWORD = 'imap-app-password-9f2c';

describe('encryptSecret / decryptSecret', () => {
  it('round-trips a credential', () => {
    const sealed = encryptSecret(PASSWORD);
    expect(sealed).not.toContain(PASSWORD);
    expect(decryptSecret(sealed)).toBe(PASSWORD);
  });

  it('round-trips unicode and an empty string', () => {
    expect(decryptSecret(encryptSecret('påsswörd-☂-密'))).toBe('påsswörd-☂-密');
    expect(decryptSecret(encryptSecret(''))).toBe('');
  });

  it('produces a different envelope every time', () => {
    const first = encryptSecret(PASSWORD);
    const second = encryptSecret(PASSWORD);
    expect(first).not.toBe(second);
    expect(decryptSecret(first)).toBe(decryptSecret(second));
  });

  it('writes the v1 envelope isEncrypted recognises', () => {
    const sealed = encryptSecret(PASSWORD);
    expect(sealed.split(':')).toHaveLength(4);
    expect(sealed.startsWith('v1:')).toBe(true);
    expect(isEncrypted(sealed)).toBe(true);
    expect(isEncrypted(PASSWORD)).toBe(false);
    expect(isEncrypted(null)).toBe(false);
  });
});

describe('decryptSecret on a payload it cannot trust', () => {
  it('returns an empty string for tampered ciphertext instead of throwing', () => {
    const parts = encryptSecret(PASSWORD).split(':');
    const flipped = parts[3][0] === 'A' ? 'B' : 'A';
    const tampered = [parts[0], parts[1], parts[2], flipped + parts[3].slice(1)].join(':');

    expect(() => decryptSecret(tampered)).not.toThrow();
    expect(decryptSecret(tampered)).toBe('');
  });

  it('returns an empty string for a tampered auth tag', () => {
    const parts = encryptSecret(PASSWORD).split(':');
    const tag = Buffer.from(parts[2], 'base64');
    tag[0] = tag[0] ^ 0xff;
    const tampered = [parts[0], parts[1], tag.toString('base64'), parts[3]].join(':');

    expect(decryptSecret(tampered)).toBe('');
  });

  it('returns an empty string for a truncated or malformed envelope', () => {
    expect(decryptSecret('')).toBe('');
    expect(decryptSecret('v1:only:three')).toBe('');
    expect(decryptSecret('v2:AAAA:BBBB:CCCC')).toBe('');
    expect(decryptSecret(encryptSecret(PASSWORD).slice(0, -4))).toBe('');
    // A short iv is rejected before the cipher is ever constructed.
    expect(decryptSecret(['v1', 'AAAA', 'BBBB', 'CCCC'].join(':'))).toBe('');
  });

  it('reads a plaintext row written before encryption existed', () => {
    expect(decryptIfEncrypted(PASSWORD)).toBe(PASSWORD);
    expect(decryptIfEncrypted(encryptSecret(PASSWORD))).toBe(PASSWORD);
    expect(decryptIfEncrypted(undefined)).toBe('');
  });
});

describe('maskSecret', () => {
  it('keeps the middle of a long secret hidden', () => {
    const secret = 'abcdefghijklmnopqrstuvwxyz';
    const masked = maskSecret(secret);

    expect(masked.startsWith('abcd')).toBe(true);
    expect(masked.endsWith('wxyz')).toBe(true);
    expect(masked).not.toContain(secret.slice(4, -4));
    // Nothing between the two visible ends survives.
    for (const char of new Set(secret.slice(4, -4))) {
      expect(masked.includes(char)).toBe(false);
    }
  });

  it('reveals nothing at all from a short secret', () => {
    for (const secret of ['a', 'hunter2', '12345678']) {
      const masked = maskSecret(secret);
      for (const char of new Set(secret)) {
        expect(masked.includes(char)).toBe(false);
      }
    }
  });

  it('never leaks the length of the hidden middle', () => {
    expect(maskSecret('abcd0000wxyz')).toBe(maskSecret(`abcd${'0'.repeat(400)}wxyz`));
  });

  it('is empty for an empty or blank value', () => {
    expect(maskSecret('')).toBe('');
    expect(maskSecret('   ')).toBe('');
  });

  it('is recognised by isMasked so a resubmitted form never overwrites a secret', () => {
    expect(isMasked(maskSecret('abcdefghijklmnop'))).toBe(true);
    expect(isMasked(maskSecret('short'))).toBe(true);
    expect(isMasked('a-real-new-password')).toBe(false);
    expect(isMasked(encryptSecret(PASSWORD))).toBe(false);
  });
});

/**
 * Encrypt-at-rest for credentials the operator types into the dashboard (IMAP
 * password, Telegram bot token, Slack webhook URL). Those land in the Setting
 * table as JSON, and JSON in Postgres is readable by anyone with a database
 * URL, so the values are sealed with AES-256-GCM before they get there.
 *
 * The key is derived from API_KEY with scrypt, so there is no second secret to
 * provision or rotate.
 *
 * ROTATING API_KEY INVALIDATES EVERY STORED SECRET. The derived key changes,
 * the GCM auth tag no longer verifies, and nothing can recover the plaintext -
 * the operator has to re-enter each credential in the dashboard. That is why
 * decryptSecret() returns '' instead of throwing: after a rotation the service
 * must degrade to "this credential is missing" (env values still apply as the
 * floor) rather than crash-looping on boot.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { env } from '../config/env';
import { child } from './logger';

const log = child('secrets');

const VERSION = 'v1';
const ALGORITHM = 'aes-256-gcm';
/** 96-bit nonce - the size GCM is specified for. */
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;

/**
 * Fixed, non-secret salt. It only has to be stable: changing it has exactly the
 * same effect as rotating API_KEY (every stored secret becomes unreadable).
 */
const APP_SALT = 'upbid.secrets.v1';

/**
 * Used only when API_KEY is unset, which the env schema allows outside
 * production. Storage is then obfuscated rather than secret, which is stated
 * out loud at startup instead of silently pretending otherwise.
 */
const DEV_KEY_MATERIAL = 'upbid-development-key-material';

/** Display filler for maskSecret. Fixed width, so the real length never leaks. */
const MASK_FILL = '••••••';
const MASK_CHAR = '•';

/** "v1:<iv b64>:<tag b64>:<ciphertext b64>" - the ciphertext is empty for ''. */
const ENCRYPTED_PATTERN = /^v1:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]+={0,2}:[A-Za-z0-9+/]*={0,2}$/;

let cachedKey: Buffer | null = null;
let warnedAboutDevKey = false;

function encryptionKey(): Buffer {
  if (cachedKey) return cachedKey;

  const material = env.API_KEY ?? '';
  if (material === '' && !warnedAboutDevKey) {
    warnedAboutDevKey = true;
    log.warn(
      'API_KEY is not set; stored credentials are encrypted with a well-known development key',
    );
  }

  // scryptSync is deliberate: this runs once per process, and the cost of the
  // derivation is what makes a leaked API_KEY expensive to brute-force.
  cachedKey = scryptSync(material === '' ? DEV_KEY_MATERIAL : material, APP_SALT, KEY_BYTES);
  return cachedKey;
}

/** Encrypts a plaintext credential into the storable "v1:iv:tag:ciphertext" form. */
export function encryptSecret(plain: string): string {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, encryptionKey(), iv);
  const ciphertext = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [
    VERSION,
    iv.toString('base64'),
    tag.toString('base64'),
    ciphertext.toString('base64'),
  ].join(':');
}

/**
 * Reverses encryptSecret. Returns '' for anything it cannot read - a malformed
 * row, a truncated value, or ciphertext written under a previous API_KEY - and
 * logs a warning. It never throws and never logs any part of the value.
 */
export function decryptSecret(stored: string): string {
  if (typeof stored !== 'string' || stored === '') return '';

  const parts = stored.split(':');
  if (parts.length !== 4 || parts[0] !== VERSION) {
    log.warn('stored secret is not in the expected v1 envelope; treating it as unset');
    return '';
  }

  try {
    const iv = Buffer.from(parts[1], 'base64');
    const tag = Buffer.from(parts[2], 'base64');
    const ciphertext = Buffer.from(parts[3], 'base64');

    if (iv.length !== IV_BYTES || tag.length !== TAG_BYTES) {
      log.warn('stored secret has a malformed iv or auth tag; treating it as unset');
      return '';
    }

    const decipher = createDecipheriv(ALGORITHM, encryptionKey(), iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    log.warn(
      'stored secret could not be decrypted; re-enter it in the dashboard (was API_KEY rotated?)',
    );
    return '';
  }
}

/** True when the value looks like output of encryptSecret. */
export function isEncrypted(value: unknown): boolean {
  return typeof value === 'string' && ENCRYPTED_PATTERN.test(value);
}

/**
 * Decrypts when the value carries the v1 envelope, otherwise returns it as-is.
 * Lets a plaintext row written before encryption existed keep working, and
 * makes re-encryption on the next write the only migration needed.
 */
export function decryptIfEncrypted(value: unknown): string {
  if (typeof value !== 'string') return '';
  return isEncrypted(value) ? decryptSecret(value) : value;
}

/**
 * Display form for the dashboard: "abcd......wxyz". The real value must never
 * leave the server, so every response that mentions a credential sends this.
 */
export function maskSecret(plain: string): string {
  if (typeof plain !== 'string') return '';
  const trimmed = plain.trim();
  if (trimmed === '') return '';
  // Too short to reveal any of it without giving away most of the secret.
  if (trimmed.length <= 8) return MASK_FILL;
  return `${trimmed.slice(0, 4)}${MASK_FILL}${trimmed.slice(-4)}`;
}

/**
 * True when the value is a maskSecret() display string that came back from the
 * browser. Writers use it to leave the stored credential alone instead of
 * overwriting a real secret with bullets when a form is resubmitted untouched.
 */
export function isMasked(value: unknown): boolean {
  return typeof value === 'string' && value.includes(MASK_CHAR);
}

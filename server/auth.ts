import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';

const SCRYPT_N = 131_072;
const SCRYPT_OPTIONS = { N: SCRYPT_N, r: 8, p: 1, maxmem: 160 * 1024 * 1024 };
let activeDerivations = 0;

export class AuthenticationBusyError extends Error {}

async function derive(password: string, salt: Buffer): Promise<Buffer> {
  if (activeDerivations >= 2) {
    throw new AuthenticationBusyError('Authentication busy; try again shortly.');
  }
  activeDerivations += 1;
  try {
    return await new Promise<Buffer>((resolve, reject) => {
      scrypt(password, salt, 32, SCRYPT_OPTIONS, (error, key) => {
        if (error) reject(error);
        else resolve(key);
      });
    });
  } finally {
    activeDerivations -= 1;
  }
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const key = await derive(password, salt);
  return `scrypt$${SCRYPT_N}$8$1$${salt.toString('hex')}$${key.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  encoded: string | null,
): Promise<boolean> {
  // Unknown usernames still perform the same expensive derivation.
  const fields = encoded?.split('$');
  const salt = fields?.[4] ?? '00000000000000000000000000000000';
  const expected = fields?.[5] ?? '0'.repeat(64);
  if (!/^[a-f0-9]{32}$/.test(salt) || !/^[a-f0-9]{64}$/.test(expected)) {
    return false;
  }
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  return timingSafeEqual(actual, Buffer.from(expected, 'hex')) && encoded !== null;
}

export function newToken(): string {
  return randomBytes(32).toString('base64url');
}

export function digest(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

import { randomBytes, scrypt, createHash, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import type { Credentials } from '../../../application/src/auth.js';
const derive = promisify(scrypt);
export class ScryptCredentials implements Credentials {
  async hash(password: string) {
    const salt = randomBytes(16).toString('hex');
    const key = (await derive(password, salt, 64)) as Buffer;
    return `scrypt$${salt}$${key.toString('hex')}`;
  }
  async verify(password: string, encoded: string) {
    const parts = encoded.split('$');
    const valid =
      parts.length === 3 &&
      parts[0] === 'scrypt' &&
      /^[a-f0-9]{32}$/.test(parts[1]!) &&
      /^[a-f0-9]{128}$/.test(parts[2]!);
    const key = (await derive(
      password,
      valid ? parts[1]! : '00000000000000000000000000000000',
      64,
    )) as Buffer;
    const target = valid ? Buffer.from(parts[2]!, 'hex') : Buffer.alloc(64);
    return timingSafeEqual(key, target) && valid;
  }
  token() {
    return randomBytes(32).toString('hex');
  }
  digest(value: string) {
    return createHash('sha256').update(value).digest('hex');
  }
}

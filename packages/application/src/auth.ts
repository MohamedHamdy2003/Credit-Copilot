import type { Actor } from '../../domain/src/access.js';
import { invariant } from '../../domain/src/errors.js';
export interface Credentials {
  verify(password: string, encoded: string): Promise<boolean>;
  token(): string;
  digest(value: string): string;
}
export interface AuthStore {
  findUser(username: string): Promise<(Actor & { passwordHash: string; active: boolean }) | null>;
  attempt(key: string): Promise<boolean>;
  createSession(hash: string, userId: string, csrf: string, expiresAt: Date): Promise<void>;
  session(hash: string): Promise<{ actor: Actor; csrf: string } | null>;
  revoke(hash: string): Promise<void>;
}
export class AuthService {
  constructor(
    private readonly store: AuthStore,
    private readonly crypto: Credentials,
    private readonly hours: number,
  ) {}
  async login(username: string, password: string, ip: string) {
    invariant(
      await this.store.attempt(this.crypto.digest(`ip:${ip}`)),
      'RateLimitExceeded',
      'Too many login attempts; try again later',
      429,
    );
    const user = await this.store.findUser(username);
    const valid = await this.crypto.verify(password, user?.passwordHash ?? 'DISABLED');
    invariant(user?.active && valid, 'InvalidCredentials', 'Invalid username or password', 401);
    const token = this.crypto.token(),
      csrf = this.crypto.token();
    await this.store.createSession(
      this.crypto.digest(token),
      user.id,
      csrf,
      new Date(Date.now() + this.hours * 3600000),
    );
    const { passwordHash: _passwordHash, active: _active, ...actor } = user;
    return { token, csrf, actor };
  }
  async authenticate(token: string | undefined) {
    invariant(token && /^[a-f0-9]{64}$/.test(token), 'Unauthenticated', 'Login required', 401);
    const session = await this.store.session(this.crypto.digest(token));
    invariant(session, 'Unauthenticated', 'Session expired or revoked', 401);
    return session;
  }
  async logout(token: string) {
    await this.store.revoke(this.crypto.digest(token));
  }
}

import type { DataSource } from 'typeorm';
import type { Actor } from '../../../domain/src/access.js';
import type { AuthStore } from '../../../application/src/auth.js';
export class PostgresAuthStore implements AuthStore {
  constructor(private readonly db: DataSource) {}
  async findUser(username: string) {
    const rows = (await this.db.query(
      'SELECT id,username,role,tier,can_ingest AS "canIngest",password_hash AS "passwordHash",active FROM cases.users WHERE username=$1',
      [username],
    )) as (Actor & { passwordHash: string; active: boolean })[];
    return rows[0] ?? null;
  }
  async attempt(key: string) {
    const rows = (await this.db.query(
      `INSERT INTO cases.login_attempts(key,attempts,window_start) VALUES($1,1,now()) ON CONFLICT(key) DO UPDATE SET attempts=CASE WHEN cases.login_attempts.window_start < now()-interval '15 minutes' THEN 1 ELSE cases.login_attempts.attempts+1 END,window_start=CASE WHEN cases.login_attempts.window_start < now()-interval '15 minutes' THEN now() ELSE cases.login_attempts.window_start END RETURNING attempts`,
      [key],
    )) as { attempts: number }[];
    return rows[0]!.attempts <= 10;
  }
  async createSession(hash: string, userId: string, csrf: string, expiresAt: Date) {
    await this.db.query(
      'INSERT INTO cases.sessions(token_hash,user_id,csrf_token,expires_at) VALUES($1,$2,$3,$4)',
      [hash, userId, csrf, expiresAt],
    );
  }
  async session(hash: string) {
    const rows = (await this.db.query(
      'SELECT u.id,u.username,u.role,u.tier,u.can_ingest AS "canIngest",s.csrf_token AS csrf FROM cases.sessions s JOIN cases.users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND u.active',
      [hash],
    )) as (Actor & { csrf: string })[];
    if (!rows[0]) return null;
    const { csrf, ...actor } = rows[0];
    return { actor, csrf };
  }
  async revoke(hash: string) {
    await this.db.query('DELETE FROM cases.sessions WHERE token_hash=$1', [hash]);
  }
}

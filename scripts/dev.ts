import 'dotenv/config';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configSchema } from '../packages/contracts/src/config.js';
const args = process.argv.slice(2);
if (args.length > 1 || (args.length === 1 && args[0] !== '--seed'))
  throw new Error('Run pnpm dev with optional --seed');
const seed = args[0] === '--seed';
const config = configSchema.parse(process.env),
  origin = new URL(config.WEB_ORIGIN);
if (origin.protocol !== 'http:') throw new Error('Local dev expects an http WEB_ORIGIN');
if (seed && !config.GEMINI_API_KEY.trim())
  throw new Error('Set GEMINI_API_KEY in .env before running pnpm dev --seed');
if (seed && (config.DEMO_PASSWORD.length < 12 || config.DEMO_PASSWORD.length > 256))
  throw new Error('Set a unique 12–256 character DEMO_PASSWORD in .env before seeding');
const children: ChildProcess[] = [];
let stopping = false;
const stop = (code = 0) => {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
};
process.once('SIGINT', () => stop());
process.once('SIGTERM', () => stop());
const start = (command: string, args: string[], env = process.env) => {
  const child = spawn(command, args, { cwd: process.cwd(), env, stdio: 'inherit' });
  children.push(child);
  return child;
};
const finish = (child: ChildProcess) =>
  new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code) =>
      code === 0 ? resolve() : reject(new Error('Local setup step failed')),
    );
  });
const runSetupScript = (file: string) => finish(start(process.execPath, ['--import', 'tsx', file]));
try {
  await finish(start('docker', ['compose', 'up', '-d', '--wait', 'db']));
  // Explicit migration CLI, never synchronize/ad-hoc schema creation in the API.
  if (!stopping) await runSetupScript('scripts/migrate.ts');
  if (!stopping && seed) {
    await runSetupScript('scripts/seed.ts');
    if (!stopping) await runSetupScript('scripts/seed-users.ts');
  }
  if (!stopping) {
    const servers = [
      start(process.execPath, ['--import', 'tsx', 'apps/api/src/main.ts']),
      start(
        process.execPath,
        [
          fileURLToPath(new URL('../node_modules/vite/bin/vite.js', import.meta.url)),
          '--config',
          'apps/web/vite.config.ts',
          '--host',
          origin.hostname,
          '--port',
          origin.port || '80',
          '--strictPort',
        ],
        { ...process.env, API_PROXY_TARGET: `http://127.0.0.1:${config.PORT}` },
      ),
    ];
    for (const child of servers) {
      child.once('error', () => stop(1));
      child.once('exit', (code) => {
        if (!stopping) stop(code || 1);
      });
    }
    console.log(
      `Credit Copilot local workspace: ${config.WEB_ORIGIN}; API port ${config.PORT}. Ctrl+C stops API/web; Docker DB is retained.`,
    );
  }
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : 'Local startup failed');
    stop(1);
  }
}

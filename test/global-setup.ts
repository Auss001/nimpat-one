import { execSync } from 'node:child_process';
import { applyTestEnv } from './test-env';

/**
 * Applies migrations (non-destructive) and the idempotent seed to the
 * dedicated test database. Tests create uniquely-named data, so the suite
 * can be re-run against the same database without wiping it.
 */
export default async function globalSetup(): Promise<void> {
  applyTestEnv();
  const env = { ...process.env };
  const run = (cmd: string) => execSync(cmd, { stdio: 'pipe', env, cwd: `${__dirname}/..` });
  run('npx prisma migrate deploy');
  run('npx ts-node --transpile-only prisma/seed.ts');
}

// npm run deploy        build, apply database migrations, deploy the Worker
// npm run db:migrate    only apply database migrations to the deployed database
import { spawnSync } from 'node:child_process';
import { assertConfigured, CONFIG } from './wrangler-config.mjs';

const ROOT = new URL('..', import.meta.url).pathname;
const run = (cmd, args) => {
  console.log(`\n> ${cmd} ${args.join(' ')}`);
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: 'inherit' });
  if (r.status !== 0) process.exit(r.status ?? 1);
};

assertConfigured();
console.log(`Using ${CONFIG}`);
const migrateOnly = process.argv.includes('--migrate-only');
if (!migrateOnly) run('npx', ['vite', 'build']);
run('npx', ['wrangler', 'd1', 'migrations', 'apply', 'open-analytics', '--remote', '-c', CONFIG]);
if (!migrateOnly) run('npx', ['wrangler', 'deploy', '-c', CONFIG]);

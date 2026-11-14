// Which wrangler config to use for anything that touches your deployed dashboard.
// wrangler.production.jsonc (git-ignored) holds your own Worker name, domain and database id, so the
// committed wrangler.jsonc stays a clean template. Without it, wrangler.jsonc is used.
import { existsSync, readFileSync } from 'node:fs';

const ROOT = new URL('..', import.meta.url).pathname;
export const CONFIG = existsSync(`${ROOT}wrangler.production.jsonc`) ? 'wrangler.production.jsonc' : 'wrangler.jsonc';

/** Stop before deploying with the template's placeholder database id. */
export function assertConfigured() {
  if (readFileSync(`${ROOT}${CONFIG}`, 'utf8').includes('00000000-0000-0000-0000-000000000000')) {
    console.error(`\n${CONFIG} still has the placeholder database_id. Run \`npx wrangler d1 create open-analytics\` and paste the id it prints (see README → Deploy).\n`);
    process.exit(1);
  }
}

import { readFileSync } from 'node:fs';
import { expect, test } from 'vitest';
import { CSP } from '../src/worker/security';

test('static files and Worker pages send the same page policy', () => {
  const headers = readFileSync(new URL('../public/_headers', import.meta.url), 'utf8');
  const line = headers.split('\n').find((l) => l.trim().startsWith('Content-Security-Policy:'));
  expect(line?.split('Content-Security-Policy:')[1].trim()).toBe(CSP);
});

test('scripts may only come from the site itself', () => {
  const script = CSP.split('; ').find((d) => d.startsWith('script-src'));
  expect(script).toBe("script-src 'self'");
  expect(CSP).not.toContain('unsafe-inline');
  expect(CSP).not.toContain('unsafe-eval');
});

import { expect, test } from 'vitest';
import { CRAWLER_PATTERN, CRAWLERS, crawlerFor } from '../src/shared/bots';

const ua = (token: string) => `Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ${token}/1.2; +https://example.com/bot)`;

test('real crawler user agents are named and sorted into the right kind', () => {
  expect(crawlerFor(ua('ChatGPT-User'))).toMatchObject({ name: 'ChatGPT', kind: 'answers' });
  expect(crawlerFor(ua('Claude-User'))).toMatchObject({ name: 'Claude', kind: 'answers' });
  expect(crawlerFor(ua('OAI-SearchBot'))).toMatchObject({ kind: 'indexing' });
  expect(crawlerFor(ua('GPTBot'))).toMatchObject({ name: 'OpenAI', kind: 'training' });
  expect(crawlerFor('Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)')).toMatchObject({ name: 'Google', kind: 'indexing' });
  expect(crawlerFor('Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)')).toMatchObject({ name: 'Bing' });
  expect(crawlerFor(ua('cohere-training-data-crawler'))).toMatchObject({ agent: 'cohere-training-data-crawler' });
});

test('browsers and unknown bots are not crawlers', () => {
  expect(crawlerFor('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36')).toBeNull();
  expect(crawlerFor('curl/8.4.0')).toBeNull();
  expect(crawlerFor('')).toBeNull();
  expect(crawlerFor(null)).toBeNull();
});

test('every listed crawler is found by the pattern the server snippet uses', () => {
  const re = new RegExp(CRAWLER_PATTERN, 'i');
  for (const c of CRAWLERS) {
    expect(re.test(ua(c.agent)), c.agent).toBe(true);
    expect(crawlerFor(ua(c.agent))?.agent, c.agent).toBe(c.agent);
  }
});

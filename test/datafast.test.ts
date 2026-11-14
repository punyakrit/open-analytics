import { expect, test } from 'vitest';
import { countryCode, sourceOf } from '../src/worker/datafast';

test("DataFast's referrers become the dashboard's sources and channels", () => {
  expect(sourceOf('Direct / None')).toMatchObject({ source: 'Direct/None', channel: 'Direct' });
  expect(sourceOf('')).toMatchObject({ source: 'Direct/None' });
  expect(sourceOf('Google')).toMatchObject({ source: 'Google', channel: 'Organic Search' });
  expect(sourceOf('news.ycombinator.com')).toMatchObject({ source: 'Hacker News' });
  expect(sourceOf('https://www.reddit.com/r/SaaS')).toMatchObject({ source: 'Reddit', domain: 'reddit.com' });
  expect(sourceOf('someblog.io')).toMatchObject({ source: 'someblog.io', channel: 'Referral', domain: 'someblog.io' });
});

test("DataFast's countries become two-letter codes", () => {
  expect(countryCode({ country: 'India', image: '🇮🇳' })).toBe('IN');
  expect(countryCode({ country: 'United Kingdom', image: '🇺🇰' })).toBe('GB'); // "UK" isn't ISO; GB is
  expect(countryCode({ country: 'United States of America' })).toBe('US');
  expect(countryCode({ country: 'Trinidad & Tobago' })).toBe('TT');
  expect(countryCode({ country: 'de' })).toBe('DE');
});

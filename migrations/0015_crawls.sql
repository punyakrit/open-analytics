-- Visits from search engines and AI crawlers (src/shared/bots.ts). They aren't people, so they never count
-- as visitors. They arrive from the site's own server (POST /api/v1/crawls) or, for the few crawlers that run
-- JavaScript, from the tracking script. Kept about a year (the cron job removes older rows).
CREATE TABLE crawls (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,   -- the crawler's user-agent token, e.g. GPTBot
  kind TEXT NOT NULL,    -- answers | indexing | training
  path TEXT NOT NULL,
  country TEXT
);
CREATE INDEX crawls_site_time ON crawls (site_id, ts);

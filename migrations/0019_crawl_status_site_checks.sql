-- What the site answered each crawler (404, 500…), when its server snippet reports it. Older snippets don't.
ALTER TABLE crawls ADD COLUMN status INTEGER;
-- Which crawlers read a given page, for comparing the sitemap with what was read.
CREATE INDEX crawls_site_path ON crawls (site_id, path, ts);
-- The latest robots.txt and sitemap check per site (site-check.ts), reused for 12 hours.
CREATE TABLE site_checks (
  site_id TEXT PRIMARY KEY,
  checked_at INTEGER NOT NULL,
  result TEXT NOT NULL
);

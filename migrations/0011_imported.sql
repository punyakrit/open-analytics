-- History imported from another analytics tool (DataFast, via scripts/import-datafast.mjs).
-- Only daily aggregates are available there, so imported days are stored as totals, not as
-- sessions/events. Imports stop the day before Open Analytics' own data for the site begins, so
-- the two never overlap; the stats queries add them together.

-- One row per site per day (YYYY-MM-DD in the site's timezone).
CREATE TABLE imported_daily (
  site_id TEXT NOT NULL,
  day TEXT NOT NULL,
  visitors INTEGER NOT NULL DEFAULT 0,
  sessions INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0, -- minor units (cents), like payments.amount
  payments INTEGER NOT NULL DEFAULT 0,
  origin TEXT NOT NULL DEFAULT 'datafast',
  PRIMARY KEY (site_id, day)
);

-- The same days broken down by a dashboard dimension (source, channel, page, country, ...).
-- `dim` uses the dashboard's own names; `label` '' means "none" (direct traffic, unknown country).
CREATE TABLE imported_breakdown (
  site_id TEXT NOT NULL,
  dim TEXT NOT NULL,
  day TEXT NOT NULL,
  label TEXT NOT NULL DEFAULT '',
  extra TEXT,
  visitors INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER, -- completions for goals
  revenue INTEGER NOT NULL DEFAULT 0,
  customers INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, dim, day, label)
);

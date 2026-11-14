-- Hourly totals imported from DataFast, so hourly charts ("Today", "Last 24 hours", "Last 2 days") show
-- the imported days' shape instead of a flat line. Only the chart uses them: the headline numbers keep
-- coming from imported_daily, whose daily unique visitors are closer to the truth than summed hours.
CREATE TABLE imported_hourly (
  site_id TEXT NOT NULL,
  hour TEXT NOT NULL, -- 'YYYY-MM-DDTHH:00' in the site's timezone, the same labels as the hourly chart
  visitors INTEGER NOT NULL DEFAULT 0,
  pageviews INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0, -- minor units
  payments INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (site_id, hour)
);

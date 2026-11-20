-- A payment in another currency than its site's is converted at that day's exchange rate. The amount as charged
-- is kept alongside (shown next to the converted amount, and used to convert again if the site's currency changes).
ALTER TABLE payments ADD COLUMN original_amount INTEGER;
ALTER TABLE payments ADD COLUMN original_currency TEXT;

-- Daily reference rates, per 1 USD, fetched once for each day a conversion needs.
CREATE TABLE fx_rates (
  day TEXT PRIMARY KEY,   -- YYYY-MM-DD (UTC)
  rates TEXT NOT NULL,    -- JSON {"eur": 0.91, "gbp": 0.76, ...}
  fetched_at INTEGER NOT NULL
);

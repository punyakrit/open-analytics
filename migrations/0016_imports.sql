-- Imports of an earlier tool's history, run in the background (src/worker/datafast.ts). One per site at a
-- time. The source's API key is stored encrypted while the import runs and removed when it ends.
CREATE TABLE imports (
  site_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL DEFAULT 'datafast',
  status TEXT NOT NULL,              -- running | done | error
  phase TEXT NOT NULL,               -- daily | hourly | breakdowns | finish
  api_key TEXT,                      -- encrypted (lib/crypto.ts); NULL once finished
  source_site TEXT,                  -- DataFast website id, only for account tokens (dft_)
  revenue_unit TEXT NOT NULL DEFAULT 'major',
  cursor TEXT,                       -- JSON: where the import is up to
  total_days INTEGER NOT NULL DEFAULT 0,
  done_days INTEGER NOT NULL DEFAULT 0,
  first_day TEXT,
  last_day TEXT,
  visitors INTEGER NOT NULL DEFAULT 0,
  revenue INTEGER NOT NULL DEFAULT 0,
  message TEXT,
  error TEXT,
  failures INTEGER NOT NULL DEFAULT 0,
  started_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  finished_at INTEGER,
  lease_until INTEGER                -- a run working on it until then; others leave it alone
);

-- Sites the owner chose to show on a public, read-only dashboard (no login needed to view).
ALTER TABLE sites ADD COLUMN public INTEGER NOT NULL DEFAULT 0;

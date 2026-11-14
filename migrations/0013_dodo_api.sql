-- Dodo Payments through its API instead of (or as well as) a webhook: the owner pastes an API key, picks
-- which Dodo brand is this site, and payments and refunds are pulled on a schedule. See src/worker/dodo.ts.
ALTER TABLE sites ADD COLUMN dodo_api_key TEXT;      -- AES-GCM encrypted with a key derived from SESSION_SECRET; never sent to a browser
ALTER TABLE sites ADD COLUMN dodo_api_mode TEXT;     -- 'live' or 'test' (which Dodo host the key belongs to)
ALTER TABLE sites ADD COLUMN dodo_brand_id TEXT;
ALTER TABLE sites ADD COLUMN dodo_brand_name TEXT;
ALTER TABLE sites ADD COLUMN dodo_sync_from INTEGER; -- payments created before this are not pulled (imported history covers them)
ALTER TABLE sites ADD COLUMN dodo_synced_at INTEGER; -- start of the last successful sync
ALTER TABLE sites ADD COLUMN dodo_sync_error TEXT;

-- Stricter owner sign-in (see the login route in src/worker/index.ts).
--  login_attempts: every password attempt, kept 30 days. Counts toward the locks and is listed in
--                  Settings → Sign-in security.
--  login_blocks:   a network (IP) that keeps getting the password wrong. Each new lock lasts twice as long
--                  as the last, up to a day.
--  auth_state:     session_epoch is part of every sign-in cookie; changing it signs out every device.
CREATE TABLE login_attempts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts INTEGER NOT NULL,
  ip TEXT NOT NULL,
  ok INTEGER NOT NULL DEFAULT 0,
  country TEXT
);
CREATE INDEX login_attempts_ts ON login_attempts (ts);
CREATE INDEX login_attempts_ip ON login_attempts (ip, ts);

CREATE TABLE login_blocks (
  ip TEXT PRIMARY KEY,
  strikes INTEGER NOT NULL,
  blocked_until INTEGER NOT NULL
);

CREATE TABLE auth_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

DROP TABLE IF EXISTS login_failures;

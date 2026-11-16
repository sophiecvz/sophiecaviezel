-- The click-notification poller that needed (event_type, seq) has been retired. No remaining
-- ingestion, Dashboard or archive query uses this index; dropping it also removes one index
-- write from every accepted event.
DROP INDEX IF EXISTS idx_events_type_seq;

-- Monthly archive lifecycle, one row per archived UTC calendar month (YYYY-MM).
-- Written only by the analytics archive Worker. The archived event set is exactly
--   occurred_at in [month start, next month start) AND seq <= snapshot_seq,
-- and min_seq/max_seq bound the rows in that set. Events are deleted only in state
-- 'purging', which requires a verified Telegram delivery ('sent') first.
-- Times are Unix milliseconds. last_error holds a fixed error class, never content.
CREATE TABLE archive_months (
  month TEXT PRIMARY KEY CHECK (
    length(month) = 7
    AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'
    AND substr(month, 6, 2) BETWEEN '01' AND '12'
  ),
  state TEXT NOT NULL CHECK (state IN ('built', 'sent', 'purging', 'purged', 'halted')),
  snapshot_seq INTEGER NOT NULL CHECK (snapshot_seq >= 0),
  min_seq INTEGER,
  max_seq INTEGER,
  row_count INTEGER NOT NULL CHECK (row_count >= 0),
  sha256 TEXT NOT NULL CHECK (length(sha256) = 64 AND NOT sha256 GLOB '*[^0-9a-f]*'),
  payload TEXT,
  payload_bytes INTEGER NOT NULL CHECK (payload_bytes > 0),
  built_at INTEGER NOT NULL,
  lease_token TEXT,
  lease_until INTEGER,
  send_attempts INTEGER NOT NULL DEFAULT 0 CHECK (send_attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  last_error TEXT CHECK (
    last_error IS NULL
    OR (length(last_error) BETWEEN 1 AND 64 AND NOT last_error GLOB '*[^a-z_]*')
  ),
  telegram_message_id INTEGER CHECK (telegram_message_id IS NULL OR telegram_message_id > 0),
  telegram_file_unique_id TEXT,
  sent_at INTEGER,
  purge_started_at INTEGER,
  deleted_rows INTEGER NOT NULL DEFAULT 0 CHECK (deleted_rows >= 0),
  purged_at INTEGER,
  late_rows INTEGER CHECK (late_rows IS NULL OR late_rows >= 0),
  CHECK (
    (row_count = 0 AND min_seq IS NULL AND max_seq IS NULL)
    OR (
      row_count > 0
      AND min_seq >= 1
      AND min_seq <= max_seq
      AND max_seq <= snapshot_seq
      AND row_count <= max_seq - min_seq + 1
    )
  ),
  CHECK (state = 'purged' OR payload IS NOT NULL),
  CHECK (state <> 'purged' OR (payload IS NULL AND purged_at IS NOT NULL)),
  CHECK (
    state NOT IN ('sent', 'purging', 'purged')
    OR (telegram_message_id IS NOT NULL AND telegram_file_unique_id IS NOT NULL AND sent_at IS NOT NULL)
  ),
  CHECK (state NOT IN ('purging', 'purged') OR purge_started_at IS NOT NULL),
  CHECK ((lease_token IS NULL) = (lease_until IS NULL))
) STRICT;

-- One row per actionable archive problem, so the owner is told once per problem.
-- Written only by the archive Worker; never read when deciding to delete events.
-- `reason` is a fixed error class; no event data or message content is stored.
CREATE TABLE archive_alerts (
  alert_key TEXT PRIMARY KEY CHECK (
    length(alert_key) BETWEEN 1 AND 64 AND NOT alert_key GLOB '*[^a-z0-9:_-]*'
  ),
  kind TEXT NOT NULL CHECK (kind IN ('halted', 'late_rows', 'send_failing', 'build_blocked')),
  month TEXT NOT NULL CHECK (
    month = 'unknown'
    OR (length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
  ),
  reason TEXT NOT NULL CHECK (
    length(reason) BETWEEN 1 AND 64 AND NOT reason GLOB '*[^a-z_]*'
  ),
  state TEXT NOT NULL DEFAULT 'pending' CHECK (state IN ('pending', 'sent')),
  created_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  next_attempt_at INTEGER NOT NULL DEFAULT 0,
  sent_at INTEGER,
  CHECK ((state = 'sent') = (sent_at IS NOT NULL))
) STRICT;

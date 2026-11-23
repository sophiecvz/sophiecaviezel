-- One row per accepted analytics event; no IP, cookies, session IDs or fingerprints.
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  event_type TEXT NOT NULL CHECK (event_type IN ('page_view', 'telegram_click', 'fanvue_click')),
  source TEXT NOT NULL
);

-- Cover date-range aggregation by source and event type.
CREATE INDEX idx_events_time_source_type ON events (occurred_at, source, event_type);

-- Support forward-only cursors for notification rules.
CREATE INDEX idx_events_type_seq ON events (event_type, seq);

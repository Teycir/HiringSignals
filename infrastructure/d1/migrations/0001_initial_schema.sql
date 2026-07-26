-- Migration 0001: initial schema (spec 8.2)
-- Applies to D1 database "hiring-signals".
-- Run: pnpm --filter @hiring-signals/api run db:migrations:apply:local
--      pnpm --filter @hiring-signals/api run db:migrations:apply:remote

CREATE TABLE companies (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  domain TEXT,
  industry TEXT,
  employee_band TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE sources (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  provider TEXT NOT NULL,
  board_token TEXT NOT NULL,
  public_url TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 360,
  next_poll_at TEXT,
  last_success_at TEXT,
  consecutive_failures INTEGER NOT NULL DEFAULT 0,
  UNIQUE(provider, board_token)
);

CREATE TABLE source_runs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  started_at TEXT NOT NULL,
  completed_at TEXT,
  status TEXT NOT NULL,
  http_status INTEGER,
  jobs_received INTEGER,
  jobs_normalized INTEGER,
  error_code TEXT,
  error_message_safe TEXT,
  raw_payload_r2_key TEXT,
  duration_ms INTEGER
);

CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  source_id TEXT NOT NULL REFERENCES sources(id),
  company_id TEXT NOT NULL REFERENCES companies(id),
  external_job_id TEXT NOT NULL,
  canonical_url TEXT NOT NULL,
  title_raw TEXT NOT NULL,
  title_normalized TEXT NOT NULL,
  description_text TEXT,
  department_raw TEXT,
  employment_type TEXT,
  location_raw TEXT,
  location_mode TEXT NOT NULL DEFAULT 'unknown',
  country_code TEXT,
  region_code TEXT,
  city TEXT,
  role_primary TEXT,
  role_tags_json TEXT NOT NULL DEFAULT '[]',
  classification_confidence REAL,
  classification_version TEXT,
  posted_at TEXT,
  source_updated_at TEXT,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  missing_run_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'active',
  content_hash TEXT NOT NULL,
  UNIQUE(source_id, external_job_id)
);

CREATE TABLE job_observations (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id),
  source_run_id TEXT NOT NULL REFERENCES source_runs(id),
  observed_at TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  is_present INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE signals (
  id TEXT PRIMARY KEY,
  company_id TEXT NOT NULL REFERENCES companies(id),
  role_category TEXT NOT NULL,
  signal_type TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  score INTEGER NOT NULL,
  score_version TEXT NOT NULL,
  first_detected_at TEXT NOT NULL,
  last_detected_at TEXT NOT NULL,
  expires_at TEXT,
  headline TEXT NOT NULL,
  summary TEXT NOT NULL
);

CREATE TABLE signal_evidence (
  id TEXT PRIMARY KEY,
  signal_id TEXT NOT NULL REFERENCES signals(id),
  job_id TEXT REFERENCES jobs(id),
  evidence_type TEXT NOT NULL,
  observed_at TEXT NOT NULL,
  payload_json TEXT NOT NULL
);

CREATE INDEX idx_jobs_filters
  ON jobs(company_id, role_primary, status, last_seen_at DESC);
CREATE INDEX idx_signals_feed
  ON signals(status, role_category, score DESC, last_detected_at DESC);
CREATE INDEX idx_source_due
  ON sources(enabled, next_poll_at);

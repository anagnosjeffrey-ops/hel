-- AutoBank schema.
--
-- The JSONB `data` column is the source of truth for each aggregate; the
-- adjacent columns are projections of it, maintained on every write, and exist
-- only so the scheduler and the lane list can be indexed queries instead of a
-- table scan. Nothing reads a projection to reconstruct domain state.

CREATE TABLE IF NOT EXISTS dealers (
  id           TEXT PRIMARY KEY,
  api_key_hash TEXT UNIQUE,
  data         JSONB NOT NULL,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS listings (
  id               TEXT PRIMARY KEY,
  seller_dealer_id TEXT NOT NULL,
  status           TEXT NOT NULL,
  opens_at         TIMESTAMPTZ,
  closes_at        TIMESTAMPTZ,
  data             JSONB NOT NULL,
  created_at       TIMESTAMPTZ NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the scheduler: "what is due to open or close right now".
CREATE INDEX IF NOT EXISTS listings_scheduled_idx
  ON listings (opens_at) WHERE status = 'scheduled';
CREATE INDEX IF NOT EXISTS listings_live_idx
  ON listings (closes_at) WHERE status = 'live';

CREATE TABLE IF NOT EXISTS sales (
  id                  TEXT PRIMARY KEY,
  listing_id          TEXT NOT NULL UNIQUE REFERENCES listings (id),
  seller_dealer_id    TEXT NOT NULL,
  buyer_dealer_id     TEXT NOT NULL,
  status              TEXT NOT NULL,
  -- Unique: a gate pass identifies exactly one vehicle movement.
  gate_pass_token     TEXT NOT NULL UNIQUE,
  inspection_deadline TIMESTAMPTZ,
  data                JSONB NOT NULL,
  awarded_at          TIMESTAMPTZ NOT NULL,
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Serves the auto-accept sweep.
CREATE INDEX IF NOT EXISTS sales_inspection_idx
  ON sales (inspection_deadline) WHERE status = 'delivered';

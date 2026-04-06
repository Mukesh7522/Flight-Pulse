-- ============================================================
-- FlightPulse Global — Complete Supabase Schema
-- ============================================================
-- Run this ONCE on a fresh Supabase project:
--   Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================

-- ─── EXTENSIONS ──────────────────────────────────────────────────────────────

-- (No extra extensions needed — all functions use built-in SQL)

-- ─── RAW TABLES ──────────────────────────────────────────────────────────────

-- Live snapshot: upserted every 60s — always holds the CURRENT position
-- of every flight. ~30,000 rows, never grows beyond that.
CREATE TABLE IF NOT EXISTS flights_live (
  icao24          TEXT PRIMARY KEY,
  callsign        TEXT,
  origin_country  TEXT,
  lon             DOUBLE PRECISION,
  lat             DOUBLE PRECISION,
  baro_altitude   DOUBLE PRECISION,
  geo_altitude    DOUBLE PRECISION,
  on_ground       BOOLEAN NOT NULL DEFAULT false,
  velocity        DOUBLE PRECISION,
  true_track      DOUBLE PRECISION,
  vertical_rate   DOUBLE PRECISION,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- History ring buffer: 1-hour rolling window (auto-purged each cycle)
-- Storage math: 30,000 flights × 60 cycles/hr × ~100 bytes ≈ 180 MB max
-- Well within Supabase free 500 MB limit.
CREATE TABLE IF NOT EXISTS flights_history (
  id              BIGSERIAL PRIMARY KEY,
  icao24          TEXT NOT NULL,
  callsign        TEXT,
  origin_country  TEXT,
  lon             DOUBLE PRECISION,
  lat             DOUBLE PRECISION,
  baro_altitude   DOUBLE PRECISION,
  geo_altitude    DOUBLE PRECISION,
  on_ground       BOOLEAN NOT NULL DEFAULT false,
  velocity        DOUBLE PRECISION,
  true_track      DOUBLE PRECISION,
  vertical_rate   DOUBLE PRECISION,
  ingested_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Anomaly hourly: pre-aggregated anomaly counts per UTC hour (max 24 rows ever)
-- Powers the 24h Anomaly Timeline chart without needing flights_history
CREATE TABLE IF NOT EXISTS anomaly_hourly (
  hour_utc      TIMESTAMPTZ PRIMARY KEY,
  ghost_count   INTEGER NOT NULL DEFAULT 0,
  low_alt_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Pipeline run log: 1 row per cycle = max 1,440 rows/day (~0.1 MB/day)
CREATE TABLE IF NOT EXISTS pipeline_runs (
  id               BIGSERIAL PRIMARY KEY,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  records_fetched  INTEGER,
  records_upserted INTEGER,
  fetch_ms         INTEGER,
  upsert_ms        INTEGER,
  status           TEXT NOT NULL DEFAULT 'success',
  error_msg        TEXT
);

-- ─── INDEXES ─────────────────────────────────────────────────────────────────

-- flights_history: fast lookups by flight + time (altitude profile explorer)
CREATE INDEX IF NOT EXISTS idx_fh_icao24_time
  ON flights_history (icao24, ingested_at DESC);

-- flights_history: fast range scans by time (anomaly timeline, purge)
CREATE INDEX IF NOT EXISTS idx_fh_ingested
  ON flights_history (ingested_at DESC);

-- flights_history: anomaly detection filter (ingested_at + on_ground)
CREATE INDEX IF NOT EXISTS idx_fh_ingested_ground
  ON flights_history (ingested_at, on_ground);

-- pipeline_runs: fast time-range scans (hourly congestion function)
CREATE INDEX IF NOT EXISTS idx_pr_run_at
  ON pipeline_runs (run_at DESC);

-- ─── ANALYTICS VIEWS ─────────────────────────────────────────────────────────
-- All views query flights_live (~30K rows) — fast, no history scanning.

-- Top airlines by live airborne flights
CREATE OR REPLACE VIEW airline_activity AS
SELECT
  CASE
    WHEN callsign LIKE 'EK%'  OR callsign LIKE 'UAE%' THEN 'Emirates'
    WHEN callsign LIKE 'RYR%' OR callsign LIKE 'FR%'  THEN 'Ryanair'
    WHEN callsign LIKE 'AAL%' OR callsign LIKE 'AA%'  THEN 'American'
    WHEN callsign LIKE 'DAL%' OR callsign LIKE 'DL%'  THEN 'Delta'
    WHEN callsign LIKE 'UAL%' OR callsign LIKE 'UA%'  THEN 'United'
    WHEN callsign LIKE 'DLH%' OR callsign LIKE 'LH%'  THEN 'Lufthansa'
    WHEN callsign LIKE 'IGO%' OR callsign LIKE 'IN%'  THEN 'IndiGo'
    WHEN callsign LIKE 'BAW%' OR callsign LIKE 'BA%'  THEN 'British Airways'
    WHEN callsign LIKE 'AFR%' OR callsign LIKE 'AF%'  THEN 'Air France'
    WHEN callsign LIKE 'QTR%' OR callsign LIKE 'QR%'  THEN 'Qatar Airways'
    WHEN callsign LIKE 'SIA%' OR callsign LIKE 'SQ%'  THEN 'Singapore Air'
    WHEN callsign LIKE 'THY%' OR callsign LIKE 'TK%'  THEN 'Turkish Airlines'
    WHEN callsign LIKE 'SVA%' OR callsign LIKE 'SV%'  THEN 'Saudia'
    WHEN callsign LIKE 'AIC%' OR callsign LIKE 'AI%'  THEN 'Air India'
    ELSE 'Other'
  END AS airline,
  COUNT(*) AS flight_count
FROM flights_live
WHERE callsign IS NOT NULL AND NOT on_ground
GROUP BY 1
ORDER BY 2 DESC;

-- Altitude distribution bands (meters → feet)
CREATE OR REPLACE VIEW altitude_distribution AS
SELECT band, COUNT(*) AS flight_count
FROM (
  SELECT
    CASE
      WHEN on_ground OR geo_altitude IS NULL THEN 'Ground'
      WHEN geo_altitude * 3.28084 < 3000    THEN 'Low'
      WHEN geo_altitude * 3.28084 < 15000   THEN 'Climbing'
      WHEN geo_altitude * 3.28084 < 45000   THEN 'Cruise'
      ELSE 'High Alt'
    END AS band
  FROM flights_live
) sub
GROUP BY 1;

-- Country activity: live airborne flights per country
CREATE OR REPLACE VIEW country_activity AS
SELECT
  origin_country,
  COUNT(*) AS flights_now
FROM flights_live
WHERE NOT on_ground AND origin_country IS NOT NULL
GROUP BY origin_country
ORDER BY flights_now DESC
LIMIT 20;

-- Ghost flights: in flights_live but not refreshed in last 2 minutes
-- (transponder went silent — could be military, failure, or emergency)
CREATE OR REPLACE VIEW ghost_flights AS
SELECT
  icao24,
  callsign,
  origin_country,
  lat,
  lon,
  ROUND((geo_altitude * 3.28084)::numeric, 0) AS altitude_ft,
  true_track,
  ingested_at,
  EXTRACT(EPOCH FROM (now() - ingested_at)) / 60 AS minutes_since_contact
FROM flights_live
WHERE
  ingested_at < now() - INTERVAL '2 minutes'
  AND NOT on_ground
ORDER BY ingested_at ASC;

-- Dashboard summary stats (single row — used by LiveMap page)
CREATE OR REPLACE VIEW dashboard_stats AS
SELECT
  COUNT(*) FILTER (WHERE NOT on_ground)                                             AS flights_in_air,
  COUNT(*) FILTER (WHERE on_ground)                                                 AS flights_on_ground,
  COUNT(DISTINCT origin_country)                                                    AS countries_active,
  COUNT(*) FILTER (WHERE ingested_at < now() - INTERVAL '2 minutes' AND NOT on_ground) AS ghost_count,
  MAX(ingested_at)                                                                  AS last_ingested_at,
  EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))::int                              AS seconds_since_sync
FROM flights_live;

-- ─── FUNCTIONS ───────────────────────────────────────────────────────────────

-- Purge history older than 1 hour (called by Python script each cycle)
-- Keeps storage under ~270 MB — safe for Supabase free tier (500 MB limit)
CREATE OR REPLACE FUNCTION purge_old_history()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM flights_history
  WHERE ingested_at < now() - INTERVAL '1 hour';
END;
$$;

-- Purge anomaly_hourly older than 25h (keeps exactly 24 data points)
CREATE OR REPLACE FUNCTION purge_old_anomaly_hourly()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM anomaly_hourly WHERE hour_utc < now() - INTERVAL '25 hours';
END;
$$;

-- Purge pipeline_runs older than 30 days (called by Python script daily)
-- Keeps at most 43,200 rows (~4 MB) — negligible storage
CREATE OR REPLACE FUNCTION purge_old_pipeline_runs()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pipeline_runs
  WHERE run_at < now() - INTERVAL '30 days';
END;
$$;

-- Hourly congestion: uses pipeline_runs (max 1,440 rows) NOT flights_history
-- Returns avg active flights per UTC hour over the last 24 hours
-- Completes in milliseconds — no risk of timeout
CREATE OR REPLACE FUNCTION get_hourly_congestion()
RETURNS TABLE(hour text, count bigint) AS $$
  WITH hours AS (
    SELECT generate_series(
      date_trunc('hour', now() - interval '23 hours'),
      date_trunc('hour', now()),
      interval '1 hour'
    ) AS hs
  ),
  agg AS (
    SELECT
      date_trunc('hour', run_at) AS hs,
      AVG(records_upserted)::bigint AS cnt
    FROM pipeline_runs
    WHERE run_at >= now() - interval '24 hours'
      AND status = 'success'
    GROUP BY 1
  )
  SELECT
    to_char(hours.hs AT TIME ZONE 'UTC', 'HH24:MI') AS hour,
    COALESCE(agg.cnt, 0) AS count
  FROM hours
  LEFT JOIN agg USING (hs)
  ORDER BY hours.hs
$$ LANGUAGE sql STABLE;

-- ─── ROW LEVEL SECURITY ──────────────────────────────────────────────────────
-- Public read allowed (anon key is safe — RLS blocks all writes from frontend)
-- Python ingestion uses service role key which bypasses RLS automatically.

ALTER TABLE flights_live    ENABLE ROW LEVEL SECURITY;
ALTER TABLE flights_history ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs   ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_hourly  ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Public read flights_live"    ON flights_live;
DROP POLICY IF EXISTS "Public read flights_history" ON flights_history;
DROP POLICY IF EXISTS "Public read pipeline_runs"   ON pipeline_runs;
DROP POLICY IF EXISTS "Public read anomaly_hourly"  ON anomaly_hourly;

CREATE POLICY "Public read flights_live"
  ON flights_live FOR SELECT USING (true);

CREATE POLICY "Public read flights_history"
  ON flights_history FOR SELECT USING (true);

CREATE POLICY "Public read pipeline_runs"
  ON pipeline_runs FOR SELECT USING (true);

CREATE POLICY "Public read anomaly_hourly"
  ON anomaly_hourly FOR SELECT USING (true);

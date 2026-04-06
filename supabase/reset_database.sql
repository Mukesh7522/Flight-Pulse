-- ============================================================
-- FlightPulse Global — Full Database Reset
-- ============================================================
-- WARNING: This drops ALL FlightPulse tables, views, functions
-- and recreates them from scratch. All data will be lost.
--
-- Usage: Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================

-- ─── STEP 1: DROP EVERYTHING ─────────────────────────────────────────────────

-- Drop views first (depend on tables)
DROP VIEW IF EXISTS airline_activity        CASCADE;
DROP VIEW IF EXISTS altitude_distribution   CASCADE;
DROP VIEW IF EXISTS country_activity        CASCADE;
DROP VIEW IF EXISTS ghost_flights           CASCADE;
DROP VIEW IF EXISTS dashboard_stats         CASCADE;

-- Drop functions
DROP FUNCTION IF EXISTS purge_old_history()         CASCADE;  -- removed
DROP FUNCTION IF EXISTS purge_old_anomaly_hourly()  CASCADE;
DROP FUNCTION IF EXISTS purge_old_pipeline_runs()   CASCADE;
DROP FUNCTION IF EXISTS get_hourly_congestion()     CASCADE;

-- Drop tables (CASCADE removes indexes + policies + sequences)
DROP TABLE IF EXISTS flights_live    CASCADE;
DROP TABLE IF EXISTS flights_history CASCADE;  -- removed: no longer used
DROP TABLE IF EXISTS anomaly_hourly  CASCADE;
DROP TABLE IF EXISTS pipeline_runs   CASCADE;

-- ─── STEP 2: CREATE TABLES ───────────────────────────────────────────────────

CREATE TABLE flights_live (
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

CREATE TABLE anomaly_hourly (
  hour_utc      TIMESTAMPTZ PRIMARY KEY,
  ghost_count   INTEGER NOT NULL DEFAULT 0,
  low_alt_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE pipeline_runs (
  id               BIGSERIAL PRIMARY KEY,
  run_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  records_fetched  INTEGER,
  records_upserted INTEGER,
  fetch_ms         INTEGER,
  upsert_ms        INTEGER,
  status           TEXT NOT NULL DEFAULT 'success',
  error_msg        TEXT
);

-- ─── STEP 3: INDEXES ─────────────────────────────────────────────────────────

CREATE INDEX idx_pr_run_at ON pipeline_runs (run_at DESC);

-- ─── STEP 4: VIEWS ───────────────────────────────────────────────────────────

CREATE VIEW airline_activity AS
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

CREATE VIEW altitude_distribution AS
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

CREATE VIEW country_activity AS
SELECT
  origin_country,
  COUNT(*) AS flights_now
FROM flights_live
WHERE NOT on_ground AND origin_country IS NOT NULL
GROUP BY origin_country
ORDER BY flights_now DESC
LIMIT 20;

CREATE VIEW ghost_flights AS
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
  NOT on_ground
  AND ingested_at < (
    SELECT MAX(run_at) - INTERVAL '30 seconds'
    FROM pipeline_runs
    WHERE status = 'success'
  )
ORDER BY ingested_at ASC;

CREATE VIEW dashboard_stats AS
SELECT
  COUNT(*) FILTER (WHERE NOT on_ground)                        AS flights_in_air,
  COUNT(*) FILTER (WHERE on_ground)                            AS flights_on_ground,
  COUNT(DISTINCT origin_country)                               AS countries_active,
  COUNT(*) FILTER (
    WHERE NOT on_ground
    AND ingested_at < (
      SELECT MAX(run_at) - INTERVAL '30 seconds'
      FROM pipeline_runs WHERE status = 'success'
    )
  )                                                            AS ghost_count,
  MAX(ingested_at)                                             AS last_ingested_at,
  EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))::int          AS seconds_since_sync
FROM flights_live;

-- ─── STEP 5: TRIGGERS ────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION refresh_ingested_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.ingested_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE TRIGGER trg_flights_live_ingested_at
BEFORE UPDATE ON flights_live
FOR EACH ROW EXECUTE FUNCTION refresh_ingested_at();

-- ─── STEP 6: FUNCTIONS ───────────────────────────────────────────────────────

CREATE FUNCTION purge_old_anomaly_hourly()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM anomaly_hourly WHERE hour_utc < now() - INTERVAL '25 hours';
END;
$$;

CREATE FUNCTION purge_old_pipeline_runs()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pipeline_runs
  WHERE run_at < now() - INTERVAL '3 days';
END;
$$;

CREATE FUNCTION get_hourly_congestion()
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

-- ─── STEP 7: ROW LEVEL SECURITY ──────────────────────────────────────────────

ALTER TABLE flights_live   ENABLE ROW LEVEL SECURITY;
ALTER TABLE pipeline_runs  ENABLE ROW LEVEL SECURITY;
ALTER TABLE anomaly_hourly ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Public read flights_live"
  ON flights_live FOR SELECT USING (true);

CREATE POLICY "Public read pipeline_runs"
  ON pipeline_runs FOR SELECT USING (true);

CREATE POLICY "Public read anomaly_hourly"
  ON anomaly_hourly FOR SELECT USING (true);

-- ─── STEP 8: VERIFY ──────────────────────────────────────────────────────────

SELECT
  (SELECT COUNT(*) FROM flights_live)   AS live_rows,
  (SELECT COUNT(*) FROM anomaly_hourly) AS anomaly_rows,
  (SELECT COUNT(*) FROM pipeline_runs)  AS pipeline_rows;

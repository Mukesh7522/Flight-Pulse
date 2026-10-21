-- ============================================================
-- FlightPulse — hardening migration (run ONCE on the live database)
-- Supabase Dashboard → SQL Editor → paste → Run
-- Safe to re-run.
-- ============================================================

-- ─── 1. Fewer false ghost alerts ─────────────────────────────────────────────
-- A flight is a ghost when its last update is older than the latest successful
-- run by more than a window. The window was 30s, but one run's chunked upsert
-- takes up to ~20s+ (and chunk timestamps differ by that much), so a slower run
-- could flag healthy flights from the same run. 75s tolerates a ~50s upsert and
-- still separates "this run" from "previous run" (runs are >= 2 min apart).
-- Same columns as before, so the frontend is unaffected.

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
  NOT on_ground
  AND ingested_at < (
    SELECT MAX(run_at) - INTERVAL '75 seconds'
    FROM pipeline_runs
    WHERE status = 'success'
  )
ORDER BY ingested_at ASC;

CREATE OR REPLACE VIEW dashboard_stats AS
SELECT
  COUNT(*) FILTER (WHERE NOT on_ground)                        AS flights_in_air,
  COUNT(*) FILTER (WHERE on_ground)                            AS flights_on_ground,
  COUNT(DISTINCT origin_country)                               AS countries_active,
  COUNT(*) FILTER (
    WHERE NOT on_ground
    AND ingested_at < (
      SELECT MAX(run_at) - INTERVAL '75 seconds'
      FROM pipeline_runs WHERE status = 'success'
    )
  )                                                            AS ghost_count,
  MAX(ingested_at)                                             AS last_ingested_at,
  EXTRACT(EPOCH FROM (now() - MAX(ingested_at)))::int          AS seconds_since_sync
FROM flights_live;

-- ─── 2. Remove orphaned history table (OPTIONAL — frees ~450k dead rows) ────
-- flights_history is no longer written by the ingestion script or read by the
-- app (the last rows are from 2026-04-04). Dropping it is irreversible.
-- Skip this block if you want to keep the old data.

DROP TABLE    IF EXISTS flights_history CASCADE;
DROP FUNCTION IF EXISTS purge_old_history();

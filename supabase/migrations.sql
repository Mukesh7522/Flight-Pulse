-- ============================================================
-- FlightPulse Global — Migrations (run on existing database)
-- ============================================================
-- If you already ran schema.sql and the pipeline is running,
-- run ONLY this file to apply the changes made during development.
-- Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================

-- ─── 1. Fix history retention: 24h → 1 hour ──────────────────────────────────
-- CRITICAL: reduces flights_history from ~43M rows to ~1.8M rows
-- Storage drops from ~6 GB → ~270 MB — fits Supabase free tier (500 MB)
CREATE OR REPLACE FUNCTION purge_old_history()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM flights_history
  WHERE ingested_at < now() - INTERVAL '1 hour';
END;
$$;

-- Run the purge immediately to free space right now
SELECT purge_old_history();

-- ─── 2. Add missing index for anomaly detection ───────────────────────────────
CREATE INDEX IF NOT EXISTS idx_fh_ingested_ground
  ON flights_history (ingested_at, on_ground);

-- ─── 3. Add pipeline_runs index for congestion function ──────────────────────
CREATE INDEX IF NOT EXISTS idx_pr_run_at
  ON pipeline_runs (run_at DESC);

-- ─── 4. Add pipeline_runs cleanup function ────────────────────────────────────
CREATE OR REPLACE FUNCTION purge_old_pipeline_runs()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM pipeline_runs
  WHERE run_at < now() - INTERVAL '30 days';
END;
$$;

-- ─── 5. Rewrite get_hourly_congestion to use pipeline_runs ───────────────────
-- Old version scanned 1.8M rows in flights_history → timed out
-- New version scans pipeline_runs (~1,440 rows) → completes in milliseconds
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

-- ─── 6. Add anomaly_hourly table for 24h chart data ─────────────────────────
-- Stores pre-aggregated anomaly counts per UTC hour (max 24 rows)
-- Replaces flights_history queries on Anomalies page — same chart, zero storage cost
CREATE TABLE IF NOT EXISTS anomaly_hourly (
  hour_utc      TIMESTAMPTZ PRIMARY KEY,
  ghost_count   INTEGER NOT NULL DEFAULT 0,
  low_alt_count INTEGER NOT NULL DEFAULT 0,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

ALTER TABLE anomaly_hourly ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "Public read anomaly_hourly" ON anomaly_hourly;
CREATE POLICY "Public read anomaly_hourly"
  ON anomaly_hourly FOR SELECT USING (true);

CREATE OR REPLACE FUNCTION purge_old_anomaly_hourly()
RETURNS void LANGUAGE plpgsql AS $$
BEGIN
  DELETE FROM anomaly_hourly WHERE hour_utc < now() - INTERVAL '25 hours';
END;
$$;

-- ─── 7. Verify everything looks correct ──────────────────────────────────────
SELECT
  (SELECT COUNT(*) FROM flights_live)    AS live_rows,
  (SELECT COUNT(*) FROM flights_history) AS history_rows,
  (SELECT COUNT(*) FROM pipeline_runs)   AS pipeline_rows;

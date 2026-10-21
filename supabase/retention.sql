-- ============================================================
-- FlightPulse — data retention (single source of truth). Safe to re-run.
-- Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================
-- Nothing is kept longer than the app can use it:
--   flights_live    15 min  (ghosts are only shown for 15 min after last contact)
--   pipeline_runs    3 days (run log / congestion chart needs 24 h)
--   anomaly_hourly  25 h    (the timeline shows 24 hourly points)
-- The ingestion script calls this every run. Optionally ALSO schedule it inside the
-- database with pg_cron (see bottom) so cleanup never depends on GitHub or the script.

CREATE OR REPLACE FUNCTION public.purge_retention()
RETURNS void
LANGUAGE plpgsql
SET search_path = public, pg_catalog
AS $$
BEGIN
  DELETE FROM flights_live    WHERE ingested_at < now() - INTERVAL '15 minutes';
  DELETE FROM pipeline_runs   WHERE run_at      < now() - INTERVAL '3 days';
  DELETE FROM anomaly_hourly  WHERE hour_utc    < now() - INTERVAL '25 hours';
END;
$$;

-- Only the database owner (ingestion script, pg_cron) may run it; the public API roles may not.
-- (RLS already stops them deleting rows, but there is no reason to leave the door open.)
REVOKE EXECUTE ON FUNCTION public.purge_retention() FROM PUBLIC, anon, authenticated;

-- Run it once now so old rows disappear immediately.
-- TIP: run this while ingestion is idle or accept that one ingestion run may fail once
-- (a bulk DELETE and the bulk upsert can collide); the script now retries automatically.
SELECT public.purge_retention();

-- ─── OPTIONAL: run the cleanup inside the database every 5 minutes (pg_cron) ──
-- 1) Supabase → Database → Extensions → enable "pg_cron"
-- 2) then run the next two statements:
--
-- SELECT cron.schedule('flightpulse-retention', '*/5 * * * *', 'SELECT public.purge_retention()');
-- -- to remove it later:  SELECT cron.unschedule('flightpulse-retention');

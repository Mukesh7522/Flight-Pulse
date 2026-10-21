-- ============================================================
-- FlightPulse — Security Advisor warnings fix (6 warnings)
-- Supabase Dashboard → SQL Editor → paste → Run   (safe to re-run)
-- ============================================================

-- 1) "Function Search Path Mutable" (4 warnings)
-- Pin the schema lookup so a function cannot be tricked into using a look-alike object.
-- No behaviour change: these functions only touch objects in `public` (and built-ins).
ALTER FUNCTION public.purge_old_anomaly_hourly()  SET search_path = public, pg_catalog;
ALTER FUNCTION public.purge_old_pipeline_runs()   SET search_path = public, pg_catalog;
ALTER FUNCTION public.get_hourly_congestion()     SET search_path = public, pg_catalog;
ALTER FUNCTION public.refresh_ingested_at()       SET search_path = public, pg_catalog;

-- 2) "Public / Signed-In Users Can Execute SECURITY DEFINER Function" (2 warnings)
-- rls_auto_enable() is Supabase's event-trigger helper that turns on Row Level Security
-- for newly created tables. It only needs to run when the DATABASE fires the event
-- trigger (permission is checked when the trigger is created, not each time it fires),
-- so the REST API roles should not be able to call it.
REVOKE EXECUTE ON FUNCTION public.rls_auto_enable() FROM PUBLIC, anon, authenticated;

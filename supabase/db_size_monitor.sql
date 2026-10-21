-- ============================================================
-- FlightPulse — database size monitor (safe to re-run)
-- Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================
-- Lets /api/health report the database size in MB and turn red before the 500 MB
-- free-tier limit. pg_database_size() is available to any role, so this is a plain
-- SECURITY INVOKER function (no elevated rights) that exposes ONE number.

CREATE OR REPLACE FUNCTION public.db_size_mb()
RETURNS numeric
LANGUAGE sql
STABLE
SET search_path = public, pg_catalog
AS $$
  SELECT round(pg_database_size(current_database()) / 1024.0 / 1024.0, 1)
$$;

GRANT EXECUTE ON FUNCTION public.db_size_mb() TO anon, authenticated;

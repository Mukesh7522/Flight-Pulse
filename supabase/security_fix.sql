-- ============================================================
-- FlightPulse — Security Advisor fix: "Security Definer View" (5 errors)
-- Supabase Dashboard → SQL Editor → paste → Run   (safe to re-run)
-- ============================================================
-- These views were created with the default SECURITY DEFINER behaviour: they run with
-- the view OWNER's permissions and therefore bypass Row Level Security on the tables
-- they read. Switching them to security_invoker makes them run with the CALLER's
-- permissions, so the table policies apply. The tables they read (flights_live,
-- pipeline_runs) already have public SELECT policies, so the app keeps working.

ALTER VIEW public.ghost_flights         SET (security_invoker = true);
ALTER VIEW public.airline_activity      SET (security_invoker = true);
ALTER VIEW public.altitude_distribution SET (security_invoker = true);
ALTER VIEW public.country_activity      SET (security_invoker = true);
ALTER VIEW public.dashboard_stats       SET (security_invoker = true);

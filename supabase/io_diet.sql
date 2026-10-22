-- ============================================================
-- FlightPulse — "disk IO diet" (run ONCE; safe to re-run)
-- Supabase Dashboard → SQL Editor → paste → Run
-- ============================================================
-- WHY: free-tier databases get a daily Disk IO budget. flights_live is rewritten ~13,000 rows
-- every 2 minutes and every change was also written to the write-ahead log (~3.9 MB per cycle
-- plus a disk sync per batch). Once the budget is spent, disk speed drops to 5 MB/s and queries
-- time out ("Your project is about to deplete its Disk IO Budget").
--
-- flights_live is only a scratch copy of OpenSky's current picture that is completely refreshed
-- every 2 minutes, so it does not need crash protection. UNLOGGED tables skip the write-ahead
-- log entirely (measured: 3.9 MB -> 0 MB per cycle). Trade-off: after a database CRASH the table
-- is emptied; the next ingestion run (<= 2 min) refills it. Normal restarts keep the data.
-- Views, policies, grants, the primary key and the trigger are unchanged.
--
-- BEFORE YOU RUN: pause the cron-job.org job (so no upload is holding the table), and run this
-- when the dashboard is not busy. lock_timeout makes it give up quickly instead of queueing and
-- blocking everyone else; if it errors with "lock timeout", just run it again in a minute.

SET lock_timeout = '10s';

ALTER TABLE public.flights_live SET (fillfactor = 85);   -- leave room so updates stay on the same page
ALTER TABLE public.flights_live SET UNLOGGED;            -- rewrites the (small) table once

-- Check: relpersistence should be 'u' (unlogged)
SELECT relname, relpersistence, reloptions FROM pg_class WHERE relname = 'flights_live';

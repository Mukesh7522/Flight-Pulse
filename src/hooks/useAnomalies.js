/**
 * useAnomalies — polls ghost_flights view + anomaly_hourly table
 *
 * anomaly_hourly: pre-aggregated per-hour counts (max 24 rows)
 *   → powers the 24h Anomaly Timeline chart
 *   → written by the Python ingestion script every 60s
 *
 * flights_history (1h retention) is no longer queried here.
 * historyCount comes from pipeline_runs sum for today.
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useAnomalies() {
  const [ghosts,      setGhosts]      = useState([])
  const [hourlyData,  setHourlyData]  = useState([])   // anomaly_hourly rows for last 24h
  const [historyCount, setHistoryCount] = useState(null)
  const [lastUpdated, setLastUpdated] = useState(null)
  const [loading,     setLoading]     = useState(true)
  const [error,       setError]       = useState(null)

  const load = useCallback(async () => {
    try {
      const todayStart = new Date()
      todayStart.setUTCHours(0, 0, 0, 0)

      const [ghostsRes, hourlyRes, runsRes] = await Promise.all([
        // Ghost flights: 15-min window, capped at 200
        supabase
          .from('ghost_flights')
          .select('*')
          .lte('minutes_since_contact', 15)
          .limit(10000),

        // 24h anomaly timeline: from pre-aggregated table (max 24 rows)
        supabase
          .from('anomaly_hourly')
          .select('hour_utc, ghost_count, low_alt_count')
          .gte('hour_utc', new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString())
          .order('hour_utc', { ascending: true }),

        // Total records ingested today: sum from pipeline_runs
        supabase
          .from('pipeline_runs')
          .select('records_upserted')
          .gte('run_at', todayStart.toISOString())
          .eq('status', 'success'),
      ])

      if (ghostsRes.error) throw ghostsRes.error
      if (hourlyRes.error) throw hourlyRes.error

      const totalToday = (runsRes.data ?? [])
        .reduce((s, r) => s + (r.records_upserted ?? 0), 0)

      setGhosts(ghostsRes.data ?? [])
      setHourlyData(hourlyRes.data ?? [])
      setHistoryCount(totalToday || null)
      setLastUpdated(Date.now())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 180_000)
    return () => clearInterval(id)
  }, [load])

  return { ghosts, hourlyData, historyCount, lastUpdated, loading, error, refresh: load }
}

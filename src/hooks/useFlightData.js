/**
 * useFlightData — live flight positions, polled every 60s
 *
 * Polls flights_live every 60s (matches the ingestion cycle).
 * Realtime was removed: Python does DELETE ALL + INSERT ALL each cycle,
 * which generates ~10,000 individual Realtime events per minute.
 *
 * Also polls dashboard_stats every 30s and ghost_flights every 60s.
 */
import { useState, useEffect, useCallback, useMemo } from 'react'
import { supabase } from '../lib/supabase'
import { fetchAllFlights } from '../lib/fetchAllFlights'

export function useFlightData() {
  const [flights, setFlights]     = useState([])   // all rows from flights_live
  const [ghostsRaw, setGhostsRaw] = useState([])   // rows from ghost_flights view
  const [stats, setStats]         = useState(null)  // row from dashboard_stats
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  // ── Initial load ────────────────────────────────────────────
  const loadFlights = useCallback(async () => {
    try {
      // Paged: a single request is capped at 10,000 rows but the table is larger
      const data = await fetchAllFlights(supabase)
      setFlights(data)
      setError(null)   // recovered — clear any earlier failure banner
    } catch (e) {
      setError(
        /failed to fetch/i.test(e.message)
          ? 'Cannot reach the database — check that the Supabase project is active and VITE_SUPABASE_URL is correct.'
          : e.message
      )
    } finally {
      setLoading(false)
    }
  }, [])

  const loadStats = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('dashboard_stats')
        .select('*')
        .single()

      if (err) throw err
      // Only update state if key values changed — avoids unnecessary map re-renders
      setStats(prev => {
        if (!prev) return data
        if (
          prev.flights_in_air    === data.flights_in_air &&
          prev.flights_on_ground === data.flights_on_ground &&
          prev.ghost_count       === data.ghost_count &&
          prev.countries_active  === data.countries_active
        ) return prev
        return data
      })
    } catch (e) {
      console.warn('dashboard_stats fetch failed:', e.message)
    }
  }, [])

  const loadGhosts = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('ghost_flights')
        .select('*')
        .lte('minutes_since_contact', 15)
        .limit(10000)

      if (err) throw err
      setGhostsRaw(data ?? [])
    } catch (e) {
      console.warn('ghost_flights fetch failed:', e.message)
    }
  }, [])

  // After a failed load, retry every 15s instead of waiting for the next 3-min poll
  useEffect(() => {
    if (!error) return
    const id = setInterval(loadFlights, 15_000)
    return () => clearInterval(id)
  }, [error, loadFlights])

  useEffect(() => {
    loadFlights()
    loadStats()
    // Stagger ghost load by 5s so all 3 don't fire simultaneously on mount
    const ghostDelay = setTimeout(loadGhosts, 5000)

    const flightsInterval = setInterval(loadFlights, 180_000)
    const statsInterval   = setInterval(loadStats,    60_000)
    const ghostsInterval  = setInterval(loadGhosts,  180_000)

    return () => {
      clearTimeout(ghostDelay)
      clearInterval(flightsInterval)
      clearInterval(statsInterval)
      clearInterval(ghostsInterval)
    }
  }, [loadFlights, loadStats, loadGhosts])

  // Pipeline health: if the ingestion script itself is down, every flight looks
  // stale — we cannot distinguish real signal loss from pipeline outage.
  // Ingestion normally runs every 2-5 min, so 15 min without data means it is down.
  const pipelineDown = stats != null && (stats.seconds_since_sync ?? 0) > 900

  // Ghosts from DB view, enriched with full flight data (velocity, track, etc.)
  // for the map info card. Returns [] when pipeline is down.
  const ghosts = useMemo(() => {
    if (pipelineDown) return []
    const flightMap = new Map(flights.map(f => [f.icao24, f]))
    return ghostsRaw.map(g => ({
      ...flightMap.get(g.icao24), // full flight fields (velocity, true_track, etc.)
      ...g,                        // ghost view fields override (altitude_ft, minutes_since_contact)
    })).filter(g => g.icao24)
  }, [ghostsRaw, flights, pipelineDown])

  return { flights, ghosts, stats, loading, error, pipelineDown }
}

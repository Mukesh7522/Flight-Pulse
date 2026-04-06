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

export function useFlightData() {
  const [flights, setFlights]     = useState([])   // all rows from flights_live
  const [ghostsRaw, setGhostsRaw] = useState([])   // rows from ghost_flights view
  const [stats, setStats]         = useState(null)  // row from dashboard_stats
  const [loading, setLoading]     = useState(true)
  const [error, setError]         = useState(null)

  // ── Initial load ────────────────────────────────────────────
  const loadFlights = useCallback(async () => {
    try {
      const { data, error: err } = await supabase
        .from('flights_live')
        .select('icao24, callsign, origin_country, lat, lon, geo_altitude, baro_altitude, on_ground, velocity, true_track, vertical_rate, ingested_at')
        .not('lat', 'is', null)
        .not('lon', 'is', null)
        .limit(10000)

      if (err) throw err
      setFlights(data ?? [])
    } catch (e) {
      setError(e.message)
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
  const pipelineDown = stats != null && (stats.seconds_since_sync ?? 0) > 3600

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

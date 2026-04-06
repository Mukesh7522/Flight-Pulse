/**
 * useAnalytics — polls analytics views every 60s
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function useAnalytics() {
  const [airlines,      setAirlines]      = useState([])
  const [altitudeBands, setAltitudeBands] = useState([])
  const [countryData,   setCountryData]   = useState([])
  const [loading,       setLoading]       = useState(true)
  const [error,         setError]         = useState(null)
  const [lastUpdated,   setLastUpdated]   = useState(null)

  const load = useCallback(async () => {
    try {
      const [airlinesRes, altRes, countryRes] = await Promise.all([
        supabase.from('airline_activity').select('*').limit(10),
        supabase.from('altitude_distribution').select('*'),
        supabase.from('country_activity').select('*').limit(20),
      ])
      if (airlinesRes.error) throw airlinesRes.error
      if (altRes.error)      throw altRes.error
      if (countryRes.error)  throw countryRes.error
      setAirlines(airlinesRes.data ?? [])
      setAltitudeBands(altRes.data ?? [])
      setCountryData(countryRes.data ?? [])
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

  return { airlines, altitudeBands, countryData, loading, error, lastUpdated, refresh: load }
}

/**
 * useAltitudeProfile — altitude history for a specific flight
 */
export function useAltitudeProfile(icao24) {
  const [profile, setProfile] = useState([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (!icao24) { setProfile([]); return }
    setLoading(true)
    supabase
      .from('flights_history')
      .select('ingested_at, geo_altitude, baro_altitude')
      .eq('icao24', icao24)
      .order('ingested_at', { ascending: true })
      .limit(60)
      .then(({ data, error }) => {
        if (!error && data) {
          setProfile(data.map(row => ({
            time: new Date(row.ingested_at).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' }),
            alt:  row.geo_altitude
              ? Math.round(row.geo_altitude  * 3.28084)
              : row.baro_altitude
                ? Math.round(row.baro_altitude * 3.28084)
                : 0,
          })))
        }
        setLoading(false)
      })
  }, [icao24])

  return { profile, loading }
}

/**
 * useCongestionTimeline — unique airborne aircraft per UTC hour, last 24h.
 * Uses get_hourly_congestion() RPC (server-side COUNT DISTINCT) so the result
 * is accurate regardless of how many raw rows flights_history contains.
 */
export function useCongestionTimeline() {
  const [data,    setData]    = useState([])
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    try {
      setError(null)
      const { data: rows, error: rpcError } = await supabase.rpc('get_hourly_congestion')
      if (rpcError) throw rpcError
      setData(rows ?? [])
    } catch (e) {
      console.warn('congestion timeline fetch failed:', e.message)
      setError(e.message)
      // keep previous data on error so chart doesn't blank out
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 180_000)
    return () => clearInterval(id)
  }, [load])

  return { data, loading, error }
}

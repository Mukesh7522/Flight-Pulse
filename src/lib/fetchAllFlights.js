/**
 * Load every row of flights_live with a position, in pages.
 *
 * Supabase caps a single request at "Max Rows" (10,000). flights_live holds ~12-20k
 * rows (airborne + grounded, up to 30 min of history), so one request silently dropped
 * 20%+ of the flights. We fetch the first page (which also returns the exact total),
 * hand it to `onFirstPage` so the map can paint immediately, then fetch the remaining
 * pages IN PARALLEL. The page size is whatever the server actually returned for the
 * first page, so this keeps working even if the server cap is lowered.
 * Ordered by icao24 (stable key) so pages don't overlap while ingestion upserts.
 */
const COLUMNS = 'icao24, callsign, origin_country, lat, lon, geo_altitude, baro_altitude, on_ground, velocity, true_track, vertical_rate, ingested_at'
const PAGE_SIZE = 5000
const MAX_ROWS  = 60_000   // safety stop

function page(supabase, from, size, withCount) {
  return supabase
    .from('flights_live')
    .select(COLUMNS, withCount ? { count: 'exact' } : undefined)
    .not('lat', 'is', null)
    .not('lon', 'is', null)
    .order('icao24')
    .range(from, from + size - 1)
}

export async function fetchAllFlights(supabase, onFirstPage) {
  const first = await page(supabase, 0, PAGE_SIZE, true)
  if (first.error) throw first.error

  const byId = new Map()
  const add = rows => { for (const r of rows ?? []) byId.set(r.icao24, r) }
  add(first.data)
  if (onFirstPage) onFirstPage([...byId.values()])

  const step  = first.data?.length ?? 0
  const total = Math.min(first.count ?? step, MAX_ROWS)
  if (step === 0 || total <= step) return [...byId.values()]

  const offsets = []
  for (let from = step; from < total; from += step) offsets.push(from)

  const rest = await Promise.all(offsets.map(from => page(supabase, from, step, false)))
  for (const r of rest) {
    if (r.error) throw r.error
    add(r.data)
  }
  return [...byId.values()]
}

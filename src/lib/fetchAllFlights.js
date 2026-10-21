/**
 * Load every row of flights_live with a position, in pages.
 *
 * Supabase caps a single request at "Max Rows" (10,000). flights_live holds ~12-20k
 * rows (airborne + grounded, up to 30 min of history), so one request silently dropped
 * 20%+ of the flights. We page with .range() and advance by the number of rows actually
 * returned, so it keeps working even if the server cap is lowered. Ordered by icao24
 * (stable key) so pages don't overlap while ingestion upserts.
 */
const COLUMNS = 'icao24, callsign, origin_country, lat, lon, geo_altitude, baro_altitude, on_ground, velocity, true_track, vertical_rate, ingested_at'
const PAGE_SIZE = 5000
const MAX_ROWS  = 60_000   // safety stop

export async function fetchAllFlights(supabase) {
  const byId = new Map()
  let from = 0
  let total = null

  while (from < MAX_ROWS) {
    const { data, error, count } = await supabase
      .from('flights_live')
      .select(COLUMNS, { count: from === 0 ? 'exact' : undefined })
      .not('lat', 'is', null)
      .not('lon', 'is', null)
      .order('icao24')
      .range(from, from + PAGE_SIZE - 1)

    if (error) throw error
    if (from === 0) total = count
    if (!data || data.length === 0) break

    for (const row of data) byId.set(row.icao24, row)
    from += data.length
    if (total != null && from >= total) break
    if (total == null && data.length < PAGE_SIZE) break
  }
  return [...byId.values()]
}

/**
 * GET /api/health — is the data pipeline alive?
 *
 * Returns 200 when flights_live was refreshed within MAX_AGE seconds,
 * otherwise 503. Point an external uptime monitor (UptimeRobot, Better Stack…)
 * at it: it needs no keys, and it alerts on the real symptom (stale data)
 * no matter which part of the pipeline broke.
 */
export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  const MAX_AGE = Number(process.env.HEALTH_MAX_AGE_SECONDS) || 600 // 10 min

  const url = process.env.VITE_SUPABASE_URL
  const key = process.env.VITE_SUPABASE_ANON_KEY
  if (!url || !key) {
    return res.status(500).json({ ok: false, reason: 'VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY not set' })
  }

  try {
    const r = await fetch(
      `${url}/rest/v1/dashboard_stats?select=seconds_since_sync,flights_in_air,ghost_count`,
      { headers: { apikey: key, Authorization: `Bearer ${key}` }, signal: AbortSignal.timeout(8000) },
    )
    if (!r.ok) {
      return res.status(503).json({ ok: false, reason: `database returned HTTP ${r.status}` })
    }
    const row = (await r.json())?.[0]
    const age = row?.seconds_since_sync
    if (age == null) {
      return res.status(503).json({ ok: false, reason: 'no data in flights_live' })
    }
    const ok = age <= MAX_AGE
    return res.status(ok ? 200 : 503).json({
      ok,
      reason: ok ? 'fresh' : `data is ${age}s old (limit ${MAX_AGE}s) — ingestion has stopped`,
      seconds_since_sync: age,
      flights_in_air: row.flights_in_air,
      ghost_count: row.ghost_count,
    })
  } catch (e) {
    return res.status(503).json({ ok: false, reason: `database unreachable: ${e.message}` })
  }
}

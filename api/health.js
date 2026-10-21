/**
 * GET /api/health — is the data pipeline alive? (and, optionally, restart it)
 *
 * Returns 200 when flights_live was refreshed within HEALTH_MAX_AGE_SECONDS
 * (default 600), otherwise 503. Point an external uptime monitor (UptimeRobot,
 * Better Stack…) at it: it needs no keys, and it alerts on the real symptom
 * (stale data) whichever part of the pipeline broke.
 *
 * SELF-HEAL (optional): if the env var GITHUB_DISPATCH_TOKEN is set and the data
 * is older than HEAL_AFTER_SECONDS (default 300), this endpoint asks GitHub to
 * run the ingestion workflow. Because the monitor calls it every 5 minutes, this
 * is a trigger that is independent of cron-job.org and of GitHub's own scheduler.
 * The ingestion script enforces a minimum gap between OpenSky calls, so extra
 * dispatches cannot burn the credit budget.
 *   GITHUB_DISPATCH_TOKEN  fine-grained token, this repo only, Actions: Read and write
 *   GITHUB_REPO            optional "owner/name" (defaults to the Vercel git repo)
 */
async function healIngestion() {
  const token = process.env.GITHUB_DISPATCH_TOKEN
  if (!token) return 'disabled (GITHUB_DISPATCH_TOKEN not set)'
  const repo = process.env.GITHUB_REPO
    || `${process.env.VERCEL_GIT_REPO_OWNER}/${process.env.VERCEL_GIT_REPO_SLUG}`
  const ref = process.env.GITHUB_REF_NAME || 'master'
  try {
    const r = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/ingest.yml/dispatches`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: 'application/vnd.github+json',
        'Content-Type': 'application/json',
        'User-Agent': 'flightpulse-health',
      },
      body: JSON.stringify({ ref }),
      signal: AbortSignal.timeout(8000),
    })
    return r.status === 204 ? 'dispatched' : `failed: GitHub returned HTTP ${r.status}${r.status === 401 ? ' (token expired or revoked)' : ''}`
  } catch (e) {
    return `failed: ${e.message}`
  }
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store')
  const MAX_AGE   = Number(process.env.HEALTH_MAX_AGE_SECONDS) || 600 // 10 min
  const HEAL_AFTER = Number(process.env.HEAL_AFTER_SECONDS)    || 300 // 5 min

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
    const body = {
      ok,
      reason: ok ? 'fresh' : `data is ${age}s old (limit ${MAX_AGE}s) — ingestion has stopped`,
      seconds_since_sync: age,
      flights_in_air: row.flights_in_air,
      ghost_count: row.ghost_count,
    }
    if (age > HEAL_AFTER) body.heal = await healIngestion()
    return res.status(ok ? 200 : 503).json(body)
  } catch (e) {
    return res.status(503).json({ ok: false, reason: `database unreachable: ${e.message}` })
  }
}

/**
 * usePipeline — reads pipeline_runs table for recent deployment/run history
 * and derives live pipeline health metrics.
 */
import { useState, useEffect, useCallback } from 'react'
import { supabase } from '../lib/supabase'

export function usePipeline() {
  const [runs,    setRuns]    = useState([])
  const [metrics, setMetrics] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error,   setError]   = useState(null)

  const load = useCallback(async () => {
    try {
      // Last 20 pipeline runs
      const { data: runs, error: runsErr } = await supabase
        .from('pipeline_runs')
        .select('*')
        .order('run_at', { ascending: false })
        .limit(20)

      if (runsErr) throw runsErr

      // Aggregate metrics from last 10 runs
      const recent = (runs ?? []).slice(0, 10)
      const successRuns = recent.filter(r => r.status === 'success')
      const avgFetchMs   = successRuns.length
        ? Math.round(successRuns.reduce((s, r) => s + (r.fetch_ms ?? 0), 0) / successRuns.length)
        : null
      const avgUpsertMs  = successRuns.length
        ? Math.round(successRuns.reduce((s, r) => s + (r.upsert_ms ?? 0), 0) / successRuns.length)
        : null
      const lastRun      = recent[0] ?? null
      const totalRecords = lastRun?.records_upserted ?? null

      setRuns(runs ?? [])
      setMetrics({
        avgFetchMs,
        avgUpsertMs,
        totalRecords,
        lastRunAt:   lastRun?.run_at ?? null,
        lastStatus:  lastRun?.status ?? null,
        successRate: recent.length
          ? Math.round((successRuns.length / recent.length) * 100)
          : null,
      })
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
    const id = setInterval(load, 30_000)
    return () => clearInterval(id)
  }, [load])

  return { runs, metrics, loading, error }
}

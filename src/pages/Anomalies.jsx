import { useMemo, useState, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer, ReferenceLine,
} from 'recharts'
import { useAnomalies } from '../hooks/useAnomalies'

// Build 24-bucket chart array from anomaly_hourly rows
// Fills gaps so all 24 hours always appear on the chart
function buildHourlyTimeline(hourlyData) {
  const buckets = {}
  for (let h = 0; h < 24; h++) {
    const label = `${String(h).padStart(2, '0')}:00`
    buckets[label] = { hour: label, ghost: 0, low_alt: 0, total: 0 }
  }
  hourlyData.forEach(row => {
    const h   = new Date(row.hour_utc).getUTCHours()
    const key = `${String(h).padStart(2, '0')}:00`
    if (buckets[key]) {
      buckets[key].ghost   = row.ghost_count   ?? 0
      buckets[key].low_alt = row.low_alt_count ?? 0
      buckets[key].total   = (row.ghost_count ?? 0) + (row.low_alt_count ?? 0)
    }
  })
  return Object.values(buckets)
}

export default function Anomalies() {
  const { ghosts, hourlyData, historyCount, lastUpdated, loading, error } = useAnomalies()

  const [countdown, setCountdown] = useState(60)
  useEffect(() => {
    if (!lastUpdated) return
    setCountdown(180)
    const id = setInterval(() => setCountdown(c => c <= 1 ? 180 : c - 1), 1000)
    return () => clearInterval(id)
  }, [lastUpdated])

  const PAGE_SIZE = 20
  const [ghostPage, setGhostPage] = useState(1)
  const totalPages  = Math.max(1, Math.ceil(ghosts.length / PAGE_SIZE))
  const pagedGhosts = ghosts.slice((ghostPage - 1) * PAGE_SIZE, ghostPage * PAGE_SIZE)

  const hourly      = useMemo(() => buildHourlyTimeline(hourlyData), [hourlyData])
  const peakBucket  = hourly.reduce((mx, d) => d.total > (mx?.total ?? 0) ? d : mx, null)
  const currentHour = `${String(new Date().getUTCHours()).padStart(2, '0')}:00`

  // Alert Distribution: 24h totals from pre-aggregated hourly data
  const totalGhost  = hourlyData.reduce((s, d) => s + (d.ghost_count   ?? 0), 0)
  const totalLowAlt = hourlyData.reduce((s, d) => s + (d.low_alt_count ?? 0), 0)
  const totalCount  = Math.max(totalGhost + totalLowAlt, 1)
  const ghostPct    = Math.round((totalGhost  / totalCount) * 100)
  const lowAltPct   = Math.round((totalLowAlt / totalCount) * 100)
  const devPct      = Math.max(0, 100 - ghostPct - lowAltPct)

  return (
    <div className="min-h-[calc(100vh-52px)] pb-[40px] bg-[#0A0E1A]">
      <main className="flex-grow p-8 max-w-[1600px] mx-auto w-full space-y-8">

        {/* ── SOC Header Banner ─────────────────────────────────────────────── */}
        <div
          className="rounded-lg overflow-hidden"
          style={{
            background: '#1A0810',
            borderLeft: '4px solid #F87171',
            boxShadow: '0 0 40px rgba(248,113,113,0.06)',
          }}
        >
          <div className="px-6 py-4 flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-error" style={{ fontVariationSettings: "'FILL' 1", fontSize: 18 }}>warning</span>
              <span className="text-[13px] font-mono font-bold text-error uppercase tracking-widest">
                Anomaly Detection
              </span>
            </div>
            <span className="text-[11px] font-mono text-secondary">
              {loading ? 'Loading…' : `${ghosts.length} active anomalies · ${historyCount != null ? historyCount.toLocaleString('en-US') : '—'} snapshots today`}&nbsp;·&nbsp;
              <span className={error ? 'text-error' : 'text-status-healthy'}>
                {error ? 'Check connection' : 'System Nominal'}
              </span>
              &nbsp;· <span className={countdown <= 5 ? 'text-primary font-bold' : ''}>next refresh {countdown}s</span>
            </span>
          </div>
        </div>

        {error && <p className="text-xs text-error font-mono px-1">{error}</p>}

        {/* ── Stats Row (moved to top) ───────────────────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          {/* Active Ghosts */}
          <div className="bg-[#0F1624] p-6 rounded-lg border border-[#1C2A40]">
            <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-4">Active Ghost Flights</div>
            <div className="flex items-center gap-3 mb-2">
              <div className="w-2.5 h-2.5 rounded-full bg-error animate-pulse" />
              <span className={`text-3xl font-bold tabular-nums ${ghosts.length > 0 ? 'text-error' : 'text-white'}`}>
                {ghosts.length}
              </span>
            </div>
            <div className={`text-[11px] font-mono ${ghosts.length > 0 ? 'text-error' : 'text-status-healthy'}`}>
              {ghosts.length > 0 ? 'Signals unaccounted for' : 'All signals nominal'}
            </div>
          </div>

          {/* History */}
          <div className="bg-[#0F1624] p-6 rounded-lg border border-[#1C2A40]">
            <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-4">History Today</div>
            <div className="text-3xl font-bold text-white tabular-nums mb-2">
              {historyCount != null
                ? historyCount >= 1_000_000
                  ? `${(historyCount / 1_000_000).toFixed(1)}M`
                  : historyCount.toLocaleString('en-US')
                : '—'}
            </div>
            <div className="text-[11px] font-mono text-secondary">Position snapshots today</div>
          </div>

          {/* Alert Distribution */}
          <div className="bg-[#0F1624] p-6 rounded-lg border border-[#1C2A40]">
            <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-4">Alert Distribution</div>
            <div className="flex gap-1 h-2 items-center mb-3">
              {[
                { pct: ghostPct,  color: '#F87171' },
                { pct: lowAltPct, color: '#FBBF24' },
                { pct: devPct,    color: '#2DD4BF' },
              ].map((seg, j, arr) => (
                <div key={j} className="h-full" style={{
                  width: `${seg.pct}%`,
                  backgroundColor: seg.color,
                  borderRadius: j === 0 ? '9999px 0 0 9999px' : j === arr.length - 1 ? '0 9999px 9999px 0' : '0',
                }} />
              ))}
            </div>
            <div className="text-[10px] font-mono text-secondary">
              <span style={{ color: '#F87171' }}>Ghost {ghostPct}%</span>
              {' · '}
              <span style={{ color: '#FBBF24' }}>Low Alt {lowAltPct}%</span>
              {' · '}
              <span style={{ color: '#2DD4BF' }}>Deviation {devPct}%</span>
            </div>
          </div>
        </div>

        {/* ── Ghost Flights Table ────────────────────────────────────────────── */}
        <section className="bg-[#0F1624] rounded-lg overflow-hidden border border-[#1C2A40]">
          <div className="px-6 py-4 border-b border-[#1C2A40] flex justify-between items-center">
            <div className="flex items-center gap-3">
              <span className="material-symbols-outlined text-error text-lg" style={{ fontVariationSettings: "'FILL' 1" }}>mist</span>
              <h2 className="text-error font-semibold text-sm uppercase tracking-widest">Ghost Flights</h2>
            </div>
            <div className="text-[11px] font-mono text-secondary uppercase tracking-tighter">
              Realtime · next refresh <span className={countdown <= 5 ? 'text-primary font-bold' : ''}>{countdown}s</span>
            </div>
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#141D2E]">
                  {['Status', 'Flight ID', 'Country', 'Last Known Pos', 'Vanished', 'Altitude', 'Action'].map(h => (
                    <th key={h} className="px-6 py-3 text-[10px] font-mono font-semibold text-secondary uppercase tracking-widest whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <caption className="sr-only">Ghost Flights — page {ghostPage} of {totalPages}</caption>
              <tbody className="divide-y divide-[#1C2A40]">
                {loading && (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-xs text-secondary font-mono animate-pulse">
                      Querying ghost_flights view…
                    </td>
                  </tr>
                )}
                {!loading && ghosts.length === 0 && (
                  <tr>
                    <td colSpan={7} className="px-6 py-8 text-center text-xs text-[#334155] font-mono">
                      No ghost flights detected. All signals nominal.
                    </td>
                  </tr>
                )}
                {pagedGhosts.map(g => (
                  <tr key={g.icao24}
                    className="transition-colors cursor-default"
                    style={{ '--hover-bg': '#1A0810' }}
                    onMouseEnter={e => e.currentTarget.style.background = '#1A0810'}
                    onMouseLeave={e => e.currentTarget.style.background = ''}
                  >
                    {/* Pulsing status dot */}
                    <td className="px-6 py-4">
                      <div className="w-2.5 h-2.5 rounded-full bg-error"
                        style={{ animation: 'ghost-pulse 1.5s ease-in-out infinite' }} />
                    </td>
                    <td className="px-6 py-4 font-mono text-white text-sm font-semibold">{g.callsign || g.icao24}</td>
                    <td className="px-6 py-4 text-sm text-on-surface-variant">{g.origin_country ?? '—'}</td>
                    <td className="px-6 py-4 font-mono text-[12px] text-on-surface-variant" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {g.lat != null ? `${Number(g.lat).toFixed(4)}° N` : '—'},{' '}
                      {g.lon != null ? `${Number(g.lon).toFixed(4)}° E` : '—'}
                    </td>
                    <td className="px-6 py-4 text-sm text-error font-mono">
                      {g.minutes_since_contact != null ? `${Math.round(g.minutes_since_contact)}m ago` : '—'}
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-on-surface-variant" style={{ fontVariantNumeric: 'tabular-nums' }}>
                      {g.altitude_ft ? `${Number(g.altitude_ft).toLocaleString()}` : '—'}
                      <span className="text-[10px] text-[#334155] ml-1 uppercase">ft</span>
                    </td>
                    <td className="px-6 py-4">
                      <span className="px-2 py-1 text-[10px] font-bold text-error border border-error rounded-sm tracking-tighter uppercase"
                        style={{ background: 'rgba(248,113,113,0.08)', boxShadow: '0 0 8px rgba(248,113,113,0.2)' }}>
                        Signal Lost
                      </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Pagination */}
          {ghosts.length > PAGE_SIZE && (
            <div className="flex items-center justify-between px-6 py-3 border-t border-[#1C2A40] bg-[#0A0E1A]">
              <span className="text-[11px] font-mono text-secondary">
                {(ghostPage - 1) * PAGE_SIZE + 1}–{Math.min(ghostPage * PAGE_SIZE, ghosts.length)} of {ghosts.length} ghosts
              </span>
              <div className="flex items-center gap-1">
                <button
                  onClick={() => setGhostPage(p => Math.max(1, p - 1))}
                  disabled={ghostPage === 1}
                  className="px-3 py-1 text-[11px] font-mono rounded border border-[#1C2A40] text-secondary hover:border-[#2A3A50] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >← Prev</button>
                {Array.from({ length: totalPages }, (_, i) => i + 1)
                  .filter(p => p === 1 || p === totalPages || Math.abs(p - ghostPage) <= 1)
                  .reduce((acc, p, i, arr) => {
                    if (i > 0 && p - arr[i - 1] > 1) acc.push('…')
                    acc.push(p)
                    return acc
                  }, [])
                  .map((p, i) => p === '…'
                    ? <span key={`dots-${i}`} className="px-2 text-[11px] font-mono text-[#334155]">…</span>
                    : <button key={p} onClick={() => setGhostPage(p)}
                        className={`w-7 h-7 text-[11px] font-mono rounded border transition-colors ${ghostPage === p ? 'bg-primary/10 border-primary text-primary' : 'border-[#1C2A40] text-secondary hover:border-[#2A3A50] hover:text-white'}`}>
                        {p}
                      </button>
                  )}
                <button
                  onClick={() => setGhostPage(p => Math.min(totalPages, p + 1))}
                  disabled={ghostPage === totalPages}
                  className="px-3 py-1 text-[11px] font-mono rounded border border-[#1C2A40] text-secondary hover:border-[#2A3A50] hover:text-white disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                >Next →</button>
              </div>
            </div>
          )}
        </section>

        {/* ── Anomaly Timeline — improved ───────────────────────────────────── */}
        <section className="bg-[#0F1624] rounded-lg p-6 border border-[#1C2A40]">
          <div className="flex items-center justify-between mb-6">
            <div>
              <h2 className="text-white text-sm font-semibold tracking-tight">Anomaly Timeline — Last 24 Hours</h2>
              <p className="text-[11px] font-mono text-secondary mt-0.5">Events per UTC hour · anomaly_hourly</p>
            </div>
            <div className="flex gap-4">
              {[
                { color: '#F87171', label: 'Ghost Flights' },
                { color: '#FBBF24', label: 'Low Altitude' },
              ].map(({ color, label }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-[10px] font-mono text-secondary uppercase tracking-widest">{label}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="h-[140px]">
            {hourlyData.length === 0 && !loading ? (
              <div className="h-full flex items-center justify-center text-xs text-[#334155] font-mono">
                No anomaly history yet — builds over time.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={hourly} margin={{ top: 8, right: 8, bottom: 0, left: 24 }}>
                  <defs>
                    <linearGradient id="ghostGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#F87171" stopOpacity={0.4} />
                      <stop offset="95%" stopColor="#F87171" stopOpacity={0.02} />
                    </linearGradient>
                    <linearGradient id="lowAltGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#FBBF24" stopOpacity={0.3} />
                      <stop offset="95%" stopColor="#FBBF24" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1C2A40" vertical={false} />
                  <XAxis dataKey="hour" tick={{ fill: '#334155', fontSize: 8, fontFamily: 'monospace' }}
                    tickLine={false} axisLine={{ stroke: '#1C2A40' }} interval={3} />
                  <YAxis tick={{ fill: '#334155', fontSize: 8, fontFamily: 'monospace' }}
                    tickLine={false} axisLine={false} width={22}
                    label={{ value: 'events/hr', fill: '#334155', fontSize: 8, fontFamily: 'monospace', angle: -90, position: 'insideLeft', offset: 8 }} />
                  <ReTooltip
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="bg-[#0F1624] border border-[#1C2A40] p-2 rounded text-xs font-mono space-y-1">
                          <p className="text-secondary">{label} UTC</p>
                          {payload.map(p => (
                            <p key={p.dataKey} style={{ color: p.color }}>{p.name}: {p.value}</p>
                          ))}
                        </div>
                      ) : null
                    }
                  />
                  {peakBucket && (
                    <ReferenceLine x={peakBucket.hour} stroke="#F87171" strokeDasharray="3 3" strokeOpacity={0.5}
                      label={{ value: `Peak ${peakBucket.total}`, fill: '#2DD4BF', fontSize: 8, fontFamily: 'monospace' }} />
                  )}
                  <ReferenceLine x={currentHour} stroke="#2DD4BF" strokeDasharray="4 3" strokeWidth={1.5}
                    label={{ value: 'NOW', fill: '#2DD4BF', fontSize: 8, fontFamily: 'monospace' }} />
                  <Area type="monotone" dataKey="ghost"   name="Ghost"     stroke="#F87171" strokeWidth={1.5} fill="url(#ghostGrad)"  dot={false} stackId="a" />
                  <Area type="monotone" dataKey="low_alt" name="Low Alt"   stroke="#FBBF24" strokeWidth={1}   fill="url(#lowAltGrad)" dot={false} stackId="a" />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

      </main>

      {/* Ghost pulse keyframe */}
      <style>{`
        @keyframes ghost-pulse {
          0%, 100% { transform: scale(1);   opacity: 1;   }
          50%       { transform: scale(1.8); opacity: 0.5; }
        }
      `}</style>

      
    </div>
  )
}

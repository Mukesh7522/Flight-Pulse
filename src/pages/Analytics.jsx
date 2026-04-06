import { useState, useMemo, useEffect } from 'react'
import {
  AreaChart, Area, XAxis, YAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer,
  ScatterChart, Scatter, ZAxis, ReferenceLine,
} from 'recharts'
import { useAnalytics, useCongestionTimeline } from '../hooks/useAnalytics'
import { useFlightData } from '../hooks/useFlightData'

const BAND_ORDER = ['Ground', 'Low', 'Climbing', 'Cruise', 'High Alt']

const BAND_COLORS = {
  'Ground':   '#64748B',
  'Low':      '#F59E0B',
  'Climbing': '#3CDDC7',
  'Cruise':   '#2563EB',
  'High Alt': '#A78BFA',
}

function AltitudeDonut({ bands }) {
  const [hovered, setHovered] = useState(null)
  const total = bands.reduce((s, b) => s + b.flight_count, 0) || 1

  const R = 100, r = 62, cx = 120, cy = 120
  let cumAngle = -Math.PI / 2

  const slices = bands.map(({ band, flight_count }) => {
    const frac = flight_count / total
    const angle = frac * 2 * Math.PI
    const startAngle = cumAngle
    cumAngle += angle
    const endAngle = cumAngle
    const largeArc = angle > Math.PI ? 1 : 0
    const x1 = cx + R * Math.cos(startAngle), y1 = cy + R * Math.sin(startAngle)
    const x2 = cx + R * Math.cos(endAngle),   y2 = cy + R * Math.sin(endAngle)
    const x3 = cx + r * Math.cos(endAngle),   y3 = cy + r * Math.sin(endAngle)
    const x4 = cx + r * Math.cos(startAngle), y4 = cy + r * Math.sin(startAngle)
    const d = `M ${x1} ${y1} A ${R} ${R} 0 ${largeArc} 1 ${x2} ${y2} L ${x3} ${y3} A ${r} ${r} 0 ${largeArc} 0 ${x4} ${y4} Z`
    return { band, flight_count, frac, d, color: BAND_COLORS[band] }
  })

  const active = hovered ? slices.find(s => s.band === hovered) : null

  return (
    <div className="flex flex-col items-center gap-4">
      <svg width={240} height={240}>
        {slices.map(s => (
          <path
            key={s.band}
            d={s.d}
            fill={s.color}
            opacity={hovered && hovered !== s.band ? 0.25 : 1}
            stroke="#0F1624"
            strokeWidth={2.5}
            style={{ cursor: 'pointer', transition: 'opacity 0.15s' }}
            onMouseEnter={() => setHovered(s.band)}
            onMouseLeave={() => setHovered(null)}
          />
        ))}
        {/* Center label */}
        <text x={cx} y={cy - 10} textAnchor="middle" fill={active ? active.color : '#CBD5E1'} fontSize={18} fontWeight="700" fontFamily="monospace">
          {active ? active.flight_count.toLocaleString() : total.toLocaleString()}
        </text>
        <text x={cx} y={cy + 8} textAnchor="middle" fill="#64748B" fontSize={10} fontFamily="monospace">
          {active ? active.band.toUpperCase() : 'TOTAL'}
        </text>
        <text x={cx} y={cy + 24} textAnchor="middle" fill="#64748B" fontSize={10} fontFamily="monospace">
          {active ? `${Math.round(active.frac * 100)}%` : 'FLIGHTS'}
        </text>
      </svg>
      {/* Legend — bottom center, horizontal */}
      <div className="flex flex-wrap justify-center gap-x-4 gap-y-2">
        {slices.map(s => (
          <div
            key={s.band}
            className="flex items-center gap-1.5 cursor-default"
            style={{ opacity: hovered && hovered !== s.band ? 0.3 : 1, transition: 'opacity 0.15s' }}
            onMouseEnter={() => setHovered(s.band)}
            onMouseLeave={() => setHovered(null)}
          >
            <span className="w-2 h-2 rounded-full shrink-0" style={{ background: s.color }} />
            <span className="text-[10px] font-mono uppercase text-[#64748B]">{s.band}</span>
            <span className="text-[10px] font-mono text-primary">{s.flight_count.toLocaleString()}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null
  return (
    <div className="bg-[#0F1624] border border-[#1C2A40] p-2 rounded text-xs font-mono">
      <p className="text-secondary">{label}</p>
      <p className="text-primary">{payload[0].value.toLocaleString()}</p>
    </div>
  )
}

const ScatterTooltip = ({ active, payload }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  if (!d) return null
  return (
    <div className="bg-[#0F1624] border border-[#1C2A40] p-2 rounded text-xs font-mono">
      <p className="text-white font-bold">{d.callsign || d.icao24}</p>
      <p className="text-primary">{d.speed} kts · {d.altitude.toLocaleString()} ft</p>
      <p className="text-secondary">{d.origin_country ?? '—'}</p>
    </div>
  )
}


export default function Analytics() {
  const { airlines, altitudeBands, countryData, loading, error, lastUpdated } = useAnalytics()
  const { flights } = useFlightData()
  const { data: congestionData, loading: congLoading } = useCongestionTimeline()
  // Countdown to next refresh, synced to when data last loaded
  const [countdown, setCountdown] = useState(60)
  useEffect(() => {
    if (!lastUpdated) return
    setCountdown(180)
    const id = setInterval(() => setCountdown(c => c <= 1 ? 180 : c - 1), 1000)
    return () => clearInterval(id)
  }, [lastUpdated])
  // Day vs Night peaks derived from real congestionData
  const morningPeak = useMemo(() => {
    const morning = congestionData.filter(d => {
      const h = parseInt(d.hour)
      return h >= 4 && h <= 11
    })
    return morning.reduce((mx, d) => d.count > (mx?.count ?? 0) ? d : mx, null)
  }, [congestionData])

  const nightPeak = useMemo(() => {
    const night = congestionData.filter(d => {
      const h = parseInt(d.hour)
      return h >= 18 || h <= 3
    })
    return night.reduce((mx, d) => d.count > (mx?.count ?? 0) ? d : mx, null)
  }, [congestionData])

  const maxHourCount = useMemo(() =>
    Math.max(...congestionData.map(d => d.count), 1)
  , [congestionData])

  const maxFlights = airlines[0]?.flight_count ?? 1
  const topAirlines = airlines.slice(0, 7)

  const sortedBands = BAND_ORDER.map(b => {
    const found = altitudeBands.find(row => row.band === b)
    return { band: b, flight_count: found?.flight_count ?? 0 }
  })
  const totalAirborne = useMemo(() =>
    countryData.reduce((s, c) => s + (c.flights_now ?? 0), 0) || 1
  , [countryData])

  const enrichedCountries = useMemo(() =>
    countryData.slice(0, 6).map((row, i) => ({
      ...row,
      sharePct: ((row.flights_now / totalAirborne) * 100).toFixed(1),
      rank: i + 1,
    }))
  , [countryData, totalAirborne])

  // ── Scatter data: speed vs altitude from live flights ────────────────────
  const scatterData = useMemo(() => {
    return flights
      .filter(f => !f.on_ground && f.velocity && f.geo_altitude)
      .map(f => ({
        icao24:         f.icao24,
        callsign:       f.callsign,
        origin_country: f.origin_country,
        speed:          Math.round(f.velocity * 1.94384),        // m/s → knots
        altitude:       Math.round(f.geo_altitude * 3.28084),    // m → feet
        band:           f.geo_altitude * 3.28084 < 3000  ? 'low' :
                        f.geo_altitude * 3.28084 < 15000 ? 'climbing' : 'cruise',
      }))
      .filter(d => d.speed > 0 && d.speed < 700 && d.altitude > 0 && d.altitude < 55000)
      .slice(0, 2000) // cap for perf
  }, [flights])

  const dotColor = band =>
    band === 'low'      ? 'rgba(251,191,36,0.55)' :
    band === 'climbing' ? 'rgba(45,212,191,0.45)' :
                          'rgba(45,212,191,0.3)'

  // Congestion: current hour marker
  const currentHour = `${String(new Date().getUTCHours()).padStart(2, '0')}:00`
  const peakHour = congestionData.reduce((mx, d) => d.count > (mx?.count ?? 0) ? d : mx, null)

  return (
    <div className="min-h-[calc(100vh-52px)] pb-[40px] bg-surface-dim">
      <main className="max-w-[1200px] mx-auto px-8 pt-8 space-y-8">

        {/* Header */}
        <header>
          <div className="flex items-end justify-between">
            <h1 className="text-[28px] font-bold text-white tracking-tight">Analytics</h1>
            {!loading && (
              <span className={`text-[11px] font-mono pb-1 ${countdown <= 10 ? 'text-primary font-bold' : 'text-[#64748B]'}`}>
                next refresh {countdown}s
              </span>
            )}
          </div>
          <p className="text-[14px] text-[#64748B] mt-1 font-mono">
            {loading
              ? 'Loading live data…'
              : `${(airlines.reduce((s, a) => s + a.flight_count, 0)).toLocaleString()} tracked flights · live`}
          </p>
          {error && <p className="text-xs text-error font-mono mt-1">{error}</p>}
        </header>

        {/* Row 1: Top Airlines + Altitude Distribution */}
        <div className="grid grid-cols-1 md:grid-cols-10 gap-6">
          <section className="md:col-span-6 bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6 flex flex-col">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Top Airlines</h2>
              {loading && <span className="text-[10px] text-secondary font-mono animate-pulse">loading…</span>}
            </div>
            <div className="space-y-5 flex-grow">
              {topAirlines.length === 0 && !loading && (
                <p className="text-xs text-[#334155] font-mono">No data yet — start the Python ingestion script.</p>
              )}
              {topAirlines.map(({ airline, flight_count }) => (
                <div key={airline} className="space-y-1.5">
                  <div className="flex justify-between text-xs font-mono">
                    <span className="text-white">{airline}</span>
                    <span className="text-primary">{flight_count.toLocaleString()}</span>
                  </div>
                  <div className="h-1 w-full bg-[#1C2A40] rounded-full overflow-hidden">
                    <div className="h-full rounded-full" style={{
                      width: `${Math.round((flight_count / maxFlights) * 100)}%`,
                      background: 'linear-gradient(145deg, #3CDDC7, #22CFBA)',
                    }} />
                  </div>
                </div>
              ))}
            </div>
          </section>

          <section className="md:col-span-4 bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Altitude Distribution</h2>
              <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-tighter">Right now</span>
            </div>
            <AltitudeDonut bands={sortedBands} />
          </section>
        </div>

        {/* Row 2: Country Activity */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-lg overflow-hidden">
          <div className="p-6 border-b border-[#1C2A40] bg-[#11192F]">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Country Activity</h2>
            <p className="text-xs text-[#64748B] mt-1">Live — top countries by airborne flights right now</p>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead className="bg-[#141D2E]/50">
                <tr>
                  {['Country', 'Flights', '% of Total', 'Share'].map(h => (
                    <th key={h} className="px-6 py-3 text-[10px] font-mono uppercase text-[#64748B] tracking-wider">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {enrichedCountries.length === 0 && !loading && (
                  <tr><td colSpan={4} className="px-6 py-6 text-xs text-[#334155] font-mono text-center">
                    No country data yet — ingestion script must be running.
                  </td></tr>
                )}
                {enrichedCountries.map(({ origin_country, flights_now, sharePct }) => (
                  <tr key={origin_country} className="hover:bg-[#141D2E] transition-colors border-b border-[#1C2A40]/50">
                    <td className="px-6 py-4 flex items-center gap-3">
                      <div className="w-5 h-4 bg-surface-container-highest rounded-sm flex items-center justify-center text-[8px] font-bold text-secondary">
                        {origin_country?.slice(0, 2).toUpperCase()}
                      </div>
                      <span className="text-sm font-semibold text-white">{origin_country}</span>
                    </td>
                    <td className="px-6 py-4 font-mono text-sm text-primary">{flights_now.toLocaleString()}</td>
                    <td className="px-6 py-4 font-mono text-sm text-on-surface">{sharePct}%</td>
                    <td className="px-6 py-4">
                      <div className="w-24 h-1.5 bg-[#1C2A40] rounded-full overflow-hidden">
                        <div className="h-full rounded-full bg-primary transition-all duration-500"
                          style={{ width: `${sharePct}%` }} />
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>

        {/* Row 4: Airline Race */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6">
          <div className="flex justify-between items-center mb-6">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Airline Race — Live</h2>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-tighter">Live</span>
          </div>
          <div className="space-y-3">
            {topAirlines.slice(0, 5).map(({ airline, flight_count }, i) => (
              <div key={airline} className="flex items-center gap-3">
                <span className="w-5 text-[10px] font-mono text-[#334155]">#{i + 1}</span>
                <span className="w-28 text-xs font-mono text-white truncate shrink-0">{airline}</span>
                <div className="flex-grow h-5 bg-[#1C2A40] rounded overflow-hidden">
                  <div className="h-full rounded transition-all duration-700" style={{
                    width: `${Math.round((flight_count / maxFlights) * 100)}%`,
                    background: 'linear-gradient(145deg, #3CDDC7, #22CFBA)',
                  }} />
                </div>
                <span className="w-14 text-right font-mono text-[10px] text-primary shrink-0">
                  {flight_count.toLocaleString()}
                </span>
              </div>
            ))}
          </div>
        </section>

        {/* ── NEW: Airspace Congestion Timeline ───────────────────────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6">
          <div className="flex justify-between items-start mb-1">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Congestion — Last 24 Hours</h2>
              <p className="text-[11px] text-[#64748B] mt-0.5 font-mono">Avg airborne flights by UTC hour · pipeline_runs</p>
            </div>
            {peakHour && (
              <span className="text-[10px] font-mono text-primary px-2 py-0.5 bg-primary/10 rounded-full">
                Peak {peakHour.hour} UTC · {peakHour.count.toLocaleString()} flights
              </span>
            )}
          </div>
          <div className="h-[160px] mt-4">
            {congLoading ? (
              <div className="h-full flex items-center justify-center text-xs text-secondary font-mono animate-pulse">
                Loading history…
              </div>
            ) : congestionData.length === 0 || congestionData.every(d => d.count === 0) ? (
              <div className="h-full flex items-center justify-center text-xs text-[#334155] font-mono">
                History builds over time — check back after a few ingestion cycles.
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={congestionData} margin={{ top: 8, right: 8, bottom: 0, left: 32 }}>
                  <defs>
                    <linearGradient id="congGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="5%"  stopColor="#2DD4BF" stopOpacity={0.25} />
                      <stop offset="95%" stopColor="#2DD4BF" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1C2A40" vertical={false} />
                  <XAxis dataKey="hour" tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={{ stroke: '#1C2A40' }} interval={3} />
                  <YAxis tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }} tickLine={false} axisLine={false} width={28} />
                  <ReTooltip
                    content={({ active, payload, label }) =>
                      active && payload?.length ? (
                        <div className="bg-[#0F1624] border border-[#1C2A40] p-2 rounded text-xs font-mono">
                          <p className="text-secondary">{label} UTC</p>
                          <p className="text-primary">{payload[0].value.toLocaleString()} flights</p>
                        </div>
                      ) : null
                    }
                  />
                  <ReferenceLine x={currentHour} stroke="#2DD4BF" strokeDasharray="4 3" strokeWidth={1}
                    label={{ value: 'NOW', fill: '#2DD4BF', fontSize: 9, fontFamily: 'monospace' }} />
                  <Area type="monotone" dataKey="count" stroke="#2DD4BF" strokeWidth={1.5}
                    fill="url(#congGrad)" dot={false} activeDot={{ r: 3, fill: '#2DD4BF', strokeWidth: 0 }} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
        </section>

        {/* ── NEW: Speed vs Altitude Scatter ──────────────────────────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6">
          <div className="flex justify-between items-start mb-1">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Flight Performance Distribution</h2>
              <p className="text-[11px] text-[#64748B] mt-0.5 font-mono">
                Speed vs Altitude · {scatterData.length.toLocaleString()} live flights
              </p>
            </div>
            <div className="flex gap-3 text-[10px] font-mono">
              {[
                { color: '#2DD4BF', label: 'Cruise' },
                { color: 'rgba(45,212,191,0.55)', label: 'Climbing' },
                { color: 'rgba(251,191,36,0.7)',  label: 'Low Alt' },
              ].map(({ color, label }) => (
                <div key={label} className="flex items-center gap-1.5">
                  <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                  <span className="text-secondary">{label}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="h-[280px] mt-4">
            {scatterData.length === 0 ? (
              <div className="h-full flex items-center justify-center text-xs text-[#334155] font-mono">
                Loading flight performance data…
              </div>
            ) : (
              <ResponsiveContainer width="100%" height="100%">
                <ScatterChart margin={{ top: 8, right: 16, bottom: 24, left: 32 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#1C2A40" />
                  <XAxis
                    type="number" dataKey="speed" name="Speed" unit=" kts"
                    domain={[0, 650]} tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                    tickLine={false} axisLine={{ stroke: '#1C2A40' }}
                    label={{ value: 'Speed (kts)', fill: '#64748B', fontSize: 9, fontFamily: 'monospace', position: 'insideBottom', offset: -12 }}
                  />
                  <YAxis
                    type="number" dataKey="altitude" name="Altitude" unit=" ft"
                    domain={[0, 50000]} tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                    tickLine={false} axisLine={false} width={36}
                    tickFormatter={v => `${(v/1000).toFixed(0)}k`}
                    label={{ value: 'Altitude (ft)', fill: '#64748B', fontSize: 9, fontFamily: 'monospace', angle: -90, position: 'insideLeft', offset: 8 }}
                  />
                  <ZAxis range={[12, 12]} />
                  <ReTooltip content={<ScatterTooltip />} />
                  {/* Cruise sweet-spot reference box */}
                  <ReferenceLine y={35000} stroke="#2DD4BF" strokeDasharray="4 3" strokeOpacity={0.3} />
                  <ReferenceLine x={450}   stroke="#2DD4BF" strokeDasharray="4 3" strokeOpacity={0.3} />
                  <Scatter
                    data={scatterData}
                    fill="#2DD4BF"
                    opacity={0.5}
                    shape={(props) => {
                      const { cx, cy, payload } = props
                      const color =
                        payload.band === 'low'      ? 'rgba(251,191,36,0.7)' :
                        payload.band === 'climbing' ? 'rgba(45,212,191,0.55)' :
                        'rgba(45,212,191,0.35)'
                      return <circle cx={cx} cy={cy} r={3} fill={color} />
                    }}
                  />
                </ScatterChart>
              </ResponsiveContainer>
            )}
          </div>
          <p className="text-[10px] text-[#334155] font-mono mt-2 text-right">
            Dense cluster at 450–500 kts / 35,000–40,000 ft = cruise sweet spot
          </p>
        </section>

        {/* Day vs Night Traffic — real congestionData */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-lg p-6">
          <div className="flex justify-between items-center mb-6">
            <div>
              <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Day vs Night Traffic</h2>
              <p className="text-[11px] text-[#64748B] mt-0.5 font-mono">Global flight density by UTC hour · last 24h</p>
            </div>
          </div>

          {congestionData.every(d => d.count === 0) ? (
            <p className="text-xs text-[#334155] font-mono">Builds over time — check back after a few ingestion cycles.</p>
          ) : (
            <>
              {/* Peak cards */}
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6 mb-6">
                {/* Morning peak */}
                <div className="bg-[#0A0E1A] border border-[#1C2A40] rounded-lg p-5">
                  <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-1">
                    {morningPeak ? `${morningPeak.hour} UTC` : '—'} — Morning Rush
                  </div>
                  <div className="text-2xl font-bold text-primary tabular-nums mb-1">
                    {morningPeak?.count.toLocaleString() ?? '—'}
                    <span className="text-xs text-secondary font-normal ml-1">flights</span>
                  </div>
                  {/* Mini bars for hours 04–11 */}
                  <div className="flex items-end gap-0.5 h-10 mt-3">
                    {congestionData.filter(d => { const h = parseInt(d.hour); return h >= 4 && h <= 11 }).map(d => (
                      <div key={d.hour} className="flex-1 rounded-sm transition-all"
                        style={{
                          height: `${Math.max(4, Math.round((d.count / maxHourCount) * 100))}%`,
                          background: d.hour === morningPeak?.hour ? '#2DD4BF' : 'rgba(45,212,191,0.3)',
                        }}
                        title={`${d.hour}: ${d.count.toLocaleString()}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between mt-1 text-[9px] font-mono text-[#334155]">
                    <span>04:00</span><span>11:00 UTC</span>
                  </div>
                </div>

                {/* Night peak */}
                <div className="bg-[#0A0E1A] border border-[#1C2A40] rounded-lg p-5">
                  <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-1">
                    {nightPeak ? `${nightPeak.hour} UTC` : '—'} — Night Traffic
                  </div>
                  <div className="text-2xl font-bold text-primary tabular-nums mb-1">
                    {nightPeak?.count.toLocaleString() ?? '—'}
                    <span className="text-xs text-secondary font-normal ml-1">flights</span>
                  </div>
                  {/* Mini bars for hours 18–23 + 0–3 */}
                  <div className="flex items-end gap-0.5 h-10 mt-3">
                    {congestionData.filter(d => { const h = parseInt(d.hour); return h >= 18 || h <= 3 }).map(d => (
                      <div key={d.hour} className="flex-1 rounded-sm transition-all"
                        style={{
                          height: `${Math.max(4, Math.round((d.count / maxHourCount) * 100))}%`,
                          background: d.hour === nightPeak?.hour ? '#2DD4BF' : 'rgba(45,212,191,0.2)',
                        }}
                        title={`${d.hour}: ${d.count.toLocaleString()}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between mt-1 text-[9px] font-mono text-[#334155]">
                    <span>18:00</span><span>03:00 UTC</span>
                  </div>
                </div>
              </div>

              {/* Full 24h bar strip */}
              <div>
                <div className="text-[10px] font-mono text-secondary uppercase tracking-widest mb-2">Full 24h distribution</div>
                <div className="flex items-end gap-px h-14">
                  {congestionData.map(d => {
                    const h = parseInt(d.hour)
                    const isDay = h >= 6 && h < 20
                    const isPeak = d.hour === morningPeak?.hour || d.hour === nightPeak?.hour
                    return (
                      <div key={d.hour} className="flex-1 rounded-sm transition-all group relative"
                        style={{
                          height: `${Math.max(4, Math.round((d.count / maxHourCount) * 100))}%`,
                          background: isPeak ? '#2DD4BF' : isDay ? 'rgba(45,212,191,0.45)' : 'rgba(45,212,191,0.2)',
                        }}
                      >
                        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-1 hidden group-hover:block bg-[#0F1624] border border-[#1C2A40] px-1.5 py-0.5 rounded text-[9px] font-mono text-white whitespace-nowrap z-10">
                          {d.hour}: {d.count.toLocaleString()}
                        </div>
                      </div>
                    )
                  })}
                </div>
                <div className="flex justify-between mt-1 text-[9px] font-mono text-[#334155]">
                  <span>00:00</span>
                  <span className="text-[#2DD4BF]/60">▌ day (06–20 UTC)</span>
                  <span>23:00 UTC</span>
                </div>
              </div>
            </>
          )}
        </section>

      </main>
      
    </div>
  )
}

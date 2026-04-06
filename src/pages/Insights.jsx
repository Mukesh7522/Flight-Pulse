import { useMemo, useState, useEffect } from 'react'
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid,
  Tooltip as ReTooltip, ResponsiveContainer, ReferenceLine,
  RadarChart, PolarGrid, PolarAngleAxis, PolarRadiusAxis, Radar,
} from 'recharts'
import { useAnalytics } from '../hooks/useAnalytics'
import { useCongestionTimeline } from '../hooks/useAnalytics'
import { useFlightData } from '../hooks/useFlightData'

// ── Country flag emoji map ────────────────────────────────────────────────
const FLAGS = {
  'United States': '🇺🇸', 'United Kingdom': '🇬🇧', 'Germany': '🇩🇪',
  'France': '🇫🇷', 'Spain': '🇪🇸', 'Italy': '🇮🇹', 'Netherlands': '🇳🇱',
  'China': '🇨🇳', 'Japan': '🇯🇵', 'India': '🇮🇳', 'South Korea': '🇰🇷',
  'Australia': '🇦🇺', 'Canada': '🇨🇦', 'Brazil': '🇧🇷', 'Mexico': '🇲🇽',
  'Turkey': '🇹🇷', 'Russia': '🇷🇺', 'UAE': '🇦🇪', 'Qatar': '🇶🇦',
  'Singapore': '🇸🇬', 'Thailand': '🇹🇭', 'Iceland': '🇮🇸', 'Ireland': '🇮🇪',
  'Norway': '🇳🇴', 'Sweden': '🇸🇪', 'Switzerland': '🇨🇭', 'Poland': '🇵🇱',
  'Saudi Arabia': '🇸🇦', 'Indonesia': '🇮🇩', 'Malaysia': '🇲🇾',
  'South Africa': '🇿🇦', 'Egypt': '🇪🇬', 'Morocco': '🇲🇦',
  'United Arab Emirates': '🇦🇪',
}

// ── Regions for radar + density ───────────────────────────────────────────
const REGIONS = [
  { name: 'N.America',  latMin: 15,  latMax: 72,  lonMin: -170, lonMax: -52  },
  { name: 'Europe',     latMin: 34,  latMax: 72,  lonMin: -25,  lonMax: 45   },
  { name: 'Asia-Pac',   latMin: -10, latMax: 70,  lonMin: 60,   lonMax: 180  },
  { name: 'Mid-East',   latMin: 12,  latMax: 42,  lonMin: 35,   lonMax: 65   },
  { name: 'S.America',  latMin: -60, latMax: 15,  lonMin: -82,  lonMax: -34  },
  { name: 'Africa',     latMin: -35, latMax: 38,  lonMin: -20,  lonMax: 52   },
  { name: 'Oceania',    latMin: -50, latMax: -10, lonMin: 110,  lonMax: 180  },
  { name: 'Russia-CIS', latMin: 50,  latMax: 80,  lonMin: 30,   lonMax: 180  },
]

// ── 24-hour Activity Clock (SVG) ─────────────────────────────────────────
function ActivityClock({ data, currentHour }) {
  const MAX_R = 82, MIN_R = 32, CX = 100, CY = 100
  const maxCount = Math.max(...data.map(d => d.count), 1)
  const total    = data.reduce((s, d) => s + d.count, 0)

  return (
    <svg viewBox="0 0 200 200" style={{ width: '100%', maxWidth: 240, display: 'block', margin: '0 auto' }}>
      {/* Background rings */}
      <circle cx={CX} cy={CY} r={MAX_R} fill="none" stroke="#1C2A40" strokeWidth={0.5} />
      <circle cx={CX} cy={CY} r={MIN_R} fill="none" stroke="#1C2A40" strokeWidth={0.5} />
      <circle cx={CX} cy={CY} r={(MAX_R + MIN_R) / 2} fill="none" stroke="#1C2A40" strokeDasharray="2 4" strokeWidth={0.3} />

      {data.map((d, i) => {
        const startDeg = i * 15 - 90
        const endDeg   = (i + 1) * 15 - 90 - 0.8   // small gap between segments
        const sRad     = startDeg * Math.PI / 180
        const eRad     = endDeg   * Math.PI / 180
        const r        = MIN_R + (d.count / maxCount) * (MAX_R - MIN_R)
        const isNow    = d.hour === currentHour
        const isPeak   = d.count === maxCount && maxCount > 0

        const x1 = CX + MIN_R * Math.cos(sRad), y1 = CY + MIN_R * Math.sin(sRad)
        const x2 = CX + r     * Math.cos(sRad), y2 = CY + r     * Math.sin(sRad)
        const x3 = CX + r     * Math.cos(eRad), y3 = CY + r     * Math.sin(eRad)
        const x4 = CX + MIN_R * Math.cos(eRad), y4 = CY + MIN_R * Math.sin(eRad)

        const fill = isNow  ? '#2DD4BF' :
                     isPeak ? 'rgba(45,212,191,0.85)' :
                     `rgba(45,212,191,${0.1 + (d.count / maxCount) * 0.65})`

        return (
          <path key={i}
            d={`M ${x1} ${y1} L ${x2} ${y2} A ${r} ${r} 0 0 1 ${x3} ${y3} L ${x4} ${y4} A ${MIN_R} ${MIN_R} 0 0 0 ${x1} ${y1} Z`}
            fill={fill}
            stroke={isNow ? '#2DD4BF' : 'rgba(28,42,64,0.4)'}
            strokeWidth={isNow ? 0.8 : 0.2}
          />
        )
      })}

      {/* Cardinal hour labels */}
      {[{ l:'00', d:-90 }, { l:'06', d:0 }, { l:'12', d:90 }, { l:'18', d:180 }].map(({ l, d }) => {
        const r   = MAX_R + 11
        const rad = d * Math.PI / 180
        return (
          <text key={l} x={CX + r * Math.cos(rad)} y={CY + r * Math.sin(rad)}
            textAnchor="middle" dominantBaseline="central"
            fill="#334155" fontSize={7} fontFamily="monospace">{l}</text>
        )
      })}

      {/* Center readout */}
      <text x={CX} y={CY - 7} textAnchor="middle" fill="#2DD4BF" fontSize={15} fontFamily="monospace" fontWeight="bold">
        {total > 0 ? total.toLocaleString() : '—'}
      </text>
      <text x={CX} y={CY + 9} textAnchor="middle" fill="#64748B" fontSize={6.5} fontFamily="monospace" letterSpacing="0.5">
        EVENTS / 24H
      </text>
    </svg>
  )
}

// ── Density Heatstrip ─────────────────────────────────────────────────────
function DensityHeatstrip({ flights }) {
  const BUCKETS  = 72   // 5° per bucket
  const LON_MIN  = -180
  const LON_SPAN = 360

  const counts = useMemo(() => {
    const arr = new Array(BUCKETS).fill(0)
    flights.filter(f => !f.on_ground && f.lon != null).forEach(f => {
      const idx = Math.floor(((f.lon - LON_MIN) / LON_SPAN) * BUCKETS)
      if (idx >= 0 && idx < BUCKETS) arr[idx]++
    })
    return arr
  }, [flights])

  const maxC = Math.max(...counts, 1)

  // Notable longitudes (label them)
  const labels = [
    { lon: -100, label: 'US' },  { lon: -50,  label: 'ATL' },
    { lon:    0, label: 'EU'  }, { lon:  20,  label: 'EUR'  },
    { lon:   80, label: 'IN'  }, { lon: 120,  label: 'CHN'  },
    { lon: 140,  label: 'JP'  },
  ]

  return (
    <div className="relative w-full">
      {/* Bars */}
      <div className="flex items-end gap-px" style={{ height: 80 }}>
        {counts.map((c, i) => {
          const ratio = c / maxC
          const pct   = Math.max(ratio * 100, 2)
          const color = ratio > 0.7 ? `rgba(255,107,53,${0.4 + ratio * 0.5})`
                      : ratio > 0.3 ? `rgba(45,212,191,${0.25 + ratio * 0.5})`
                      : ratio > 0.05 ? `rgba(45,212,191,0.18)`
                      : `rgba(28,42,64,0.3)`
          return (
            <div key={i} className="flex-1 rounded-sm transition-all duration-700"
              style={{ height: `${pct}%`, backgroundColor: color }} />
          )
        })}
      </div>

      {/* Longitude labels */}
      <div className="relative h-5 w-full mt-1">
        {labels.map(({ lon, label }) => {
          const pct = ((lon - LON_MIN) / LON_SPAN) * 100
          return (
            <span key={label}
              className="absolute text-[9px] font-mono text-[#334155] -translate-x-1/2"
              style={{ left: `${pct}%` }}>
              {label}
            </span>
          )
        })}
      </div>

      {/* Axis labels */}
      <div className="flex justify-between text-[8px] font-mono text-[#1C2A40] mt-3">
        <span>180°W</span><span>90°W</span><span>0°</span><span>90°E</span><span>180°E</span>
      </div>
    </div>
  )
}

// ── Scatter tooltip ───────────────────────────────────────────────────────
const ScatterTip = ({ active, payload }) => {
  if (!active || !payload?.length) return null
  const d = payload[0]?.payload
  return d ? (
    <div className="bg-[#0F1624] border border-[#1C2A40] p-2 rounded text-xs font-mono">
      <p className="text-white font-bold">{d.callsign || d.icao24}</p>
      <p className="text-primary">{d.speed} kts · {d.altitude.toLocaleString()} ft</p>
      <p className="text-secondary">{d.origin_country ?? '—'}</p>
    </div>
  ) : null
}

// ── Main component ────────────────────────────────────────────────────────
export default function Insights() {
  const { airlines, loading: aLoading, lastUpdated } = useAnalytics()
  const { data: congestion }                         = useCongestionTimeline()
  const { flights }                                  = useFlightData()

  const [countdown, setCountdown] = useState(60)
  useEffect(() => {
    if (!lastUpdated) return
    setCountdown(180)
    const id = setInterval(() => setCountdown(c => c <= 1 ? 180 : c - 1), 1000)
    return () => clearInterval(id)
  }, [lastUpdated])

  const currentHour = `${String(new Date().getUTCHours()).padStart(2, '0')}:00`
  const airborne    = useMemo(() => flights.filter(f => !f.on_ground && f.lat != null && f.lon != null), [flights])

  // ── Scatter data ────────────────────────────────────────────────────────
  const scatterData = useMemo(() =>
    airborne.filter(f => f.velocity && f.geo_altitude).map(f => ({
      icao24:         f.icao24,
      callsign:       f.callsign,
      origin_country: f.origin_country,
      speed:    Math.round(f.velocity * 1.94384),
      altitude: Math.round(f.geo_altitude * 3.28084),
      band:     f.geo_altitude * 3.28084 < 1000  ? 'ground'   :
                f.geo_altitude * 3.28084 < 10000 ? 'low'      :
                f.geo_altitude * 3.28084 < 25000 ? 'climbing' :
                f.geo_altitude * 3.28084 < 40000 ? 'cruise'   : 'high',
    })).filter(d => d.speed > 0 && d.speed < 700 && d.altitude > 0).slice(0, 2500),
  [airborne])

  const DOT_COLORS = {
    ground: '#64748B', low: '#FBBF24', climbing: '#60A5FA', cruise: '#2DD4BF', high: '#A78BFA'
  }

  // ── Country speed ranking ───────────────────────────────────────────────
  const countrySpeed = useMemo(() => {
    const map = {}
    airborne.filter(f => f.velocity && f.origin_country).forEach(f => {
      const kts = f.velocity * 1.94384
      if (!map[f.origin_country]) map[f.origin_country] = { sum: 0, n: 0 }
      map[f.origin_country].sum += kts
      map[f.origin_country].n++
    })
    return Object.entries(map)
      .filter(([, v]) => v.n >= 3)
      .map(([country, v]) => ({
        country,
        avg:   Math.round(v.sum / v.n),
        count: v.n,
        flag:  FLAGS[country] ?? '🌐',
      }))
      .sort((a, b) => b.avg - a.avg)
      .slice(0, 15)
  }, [airborne])

  const maxSpeed = countrySpeed[0]?.avg || 1

  // ── Radar data (region activity scores 0-100) ───────────────────────────
  const radarData = useMemo(() => {
    const maxRegion = Math.max(...REGIONS.map(r =>
      airborne.filter(f => f.lat >= r.latMin && f.lat <= r.latMax && f.lon >= r.lonMin && f.lon <= r.lonMax).length
    ), 1)
    return REGIONS.map(r => {
      const count = airborne.filter(f =>
        f.lat >= r.latMin && f.lat <= r.latMax && f.lon >= r.lonMin && f.lon <= r.lonMax
      ).length
      return { region: r.name, score: Math.round((count / maxRegion) * 100) }
    })
  }, [airborne])

  // ── Airline race — top 10 ───────────────────────────────────────────────
  // Exclude catch-all "Other" bucket — it's an aggregate, not a real airline
  const topTen     = airlines.filter(a => a.airline !== 'Other').slice(0, 10)
  const maxFlights = topTen[0]?.flight_count || 1

  return (
    <div className="min-h-[calc(100vh-52px)] pb-[40px] bg-[#0A0E1A]">
      <main className="max-w-[1300px] mx-auto px-8 pt-8 space-y-8">

        {/* ── Page Header ───────────────────────────────────────────────── */}
        <header className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div>
            <h1 className="text-[28px] font-bold text-white tracking-tight">World Insights</h1>
            <p className="text-[14px] text-[#64748B] mt-1">Deep analysis of global flight patterns</p>
          </div>
          <span className={`px-3 py-1.5 rounded-lg bg-primary/10 text-[11px] font-bold font-mono uppercase tracking-wider border border-primary/20 ${countdown <= 10 ? 'text-primary' : 'text-secondary'}`}>
            Live · next refresh {countdown}s
          </span>
        </header>

        {/* ── Section 1: Airline Race ───────────────────────────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Airline Race</h2>
            <span className="px-2 py-0.5 rounded-full bg-primary/10 text-primary text-[10px] font-bold uppercase tracking-tighter">
              Live
            </span>
          </div>
          <p className="text-[11px] text-[#334155] font-mono mb-6">
            Top airlines by flights in air right now · updates every 60s
          </p>

          {aLoading ? (
            <p className="text-xs text-secondary font-mono animate-pulse">Loading airline data…</p>
          ) : (
            <div className="space-y-3">
              {topTen.map(({ airline, flight_count }, i) => (
                <div key={airline} className="flex items-center gap-4">
                  {/* Rank */}
                  <span className="w-6 text-[11px] font-bold font-mono tabular-nums"
                    style={{ color: i === 0 ? '#2DD4BF' : '#334155' }}>
                    #{i + 1}
                  </span>

                  {/* Name */}
                  <span className="w-36 text-sm text-white truncate shrink-0">{airline}</span>

                  {/* Bar track */}
                  <div className="flex-grow h-5 bg-[#1C2A40] rounded overflow-hidden relative">
                    <div
                      className="h-full rounded flex items-center justify-end pr-2"
                      style={{
                        width: `${Math.round((flight_count / maxFlights) * 100)}%`,
                        background: i === 0
                          ? 'linear-gradient(90deg, #1C7A6C, #2DD4BF)'
                          : 'linear-gradient(90deg, #1A2E3A, #2DD4BF80)',
                        transition: 'width 400ms ease',
                        minWidth: 32,
                      }}>
                      {i === 0 && (
                        <span className="material-symbols-outlined mr-1" style={{ fontSize: 11 }} aria-hidden>flight</span>
                      )}
                    </div>
                  </div>

                  {/* Count */}
                  <span className="w-16 text-right font-mono text-sm text-primary tabular-nums shrink-0">
                    {flight_count.toLocaleString()}
                  </span>
                </div>
              ))}
              {topTen.length === 0 && (
                <p className="text-xs text-[#334155] font-mono">No airline data — ingestion script must be running.</p>
              )}
            </div>
          )}
        </section>

        {/* ── Section 2: Speed vs Altitude Scatter ─────────────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Flight Performance Distribution</h2>
            <span className="text-[11px] font-mono text-[#334155]">{scatterData.length.toLocaleString()} live flights</span>
          </div>
          <p className="text-[11px] text-[#334155] font-mono mb-4">Speed vs Altitude — all airborne aircraft</p>

          {/* Legend */}
          <div className="flex flex-wrap gap-4 mb-4">
            {Object.entries(DOT_COLORS).map(([band, color]) => (
              <div key={band} className="flex items-center gap-1.5">
                <div className="w-2 h-2 rounded-full" style={{ backgroundColor: color }} />
                <span className="text-[10px] font-mono text-secondary capitalize">{band}</span>
              </div>
            ))}
          </div>

          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <ScatterChart margin={{ top: 8, right: 16, bottom: 28, left: 36 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1C2A40" />
                <XAxis type="number" dataKey="speed"    name="Speed"    domain={[0, 650]}
                  tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                  tickLine={false} axisLine={{ stroke: '#1C2A40' }}
                  label={{ value: 'Speed (knots)', fill: '#64748B', fontSize: 9, fontFamily: 'monospace', position: 'insideBottom', offset: -14 }} />
                <YAxis type="number" dataKey="altitude" name="Altitude" domain={[0, 50000]}
                  tick={{ fill: '#334155', fontSize: 9, fontFamily: 'monospace' }}
                  tickLine={false} axisLine={false} width={38}
                  tickFormatter={v => `${(v/1000).toFixed(0)}k`}
                  label={{ value: 'Alt (ft)', fill: '#64748B', fontSize: 9, fontFamily: 'monospace', angle: -90, position: 'insideLeft', offset: 10 }} />
                <ZAxis range={[16, 16]} />
                <ReTooltip content={<ScatterTip />} />
                <ReferenceLine x={450}   stroke="#1C2A40" strokeDasharray="4 3"
                  label={{ value: 'Cruise speed', fill: '#64748B', fontSize: 8, fontFamily: 'monospace' }} />
                <ReferenceLine y={35000} stroke="#1C2A40" strokeDasharray="4 3"
                  label={{ value: '35k ft', fill: '#64748B', fontSize: 8, fontFamily: 'monospace', position: 'insideTopLeft' }} />
                <Scatter data={scatterData}
                  shape={({ cx, cy, payload }) => (
                    <circle cx={cx} cy={cy} r={3}
                      fill={DOT_COLORS[payload.band] ?? '#2DD4BF'}
                      opacity={0.38} />
                  )}
                />
              </ScatterChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] text-[#334155] font-mono mt-1 text-right">
            Dense cluster at 450–500 kts / 35,000 ft = commercial cruise sweet spot
          </p>
        </section>

        {/* ── Section 3: Activity Clock + Radar ────────────────────────── */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">

          {/* 24-Hour Activity Clock */}
          <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary mb-1">
              24 Hour Activity Pattern
            </h2>
            <p className="text-[11px] text-[#334155] font-mono mb-6">
              Flights per UTC hour · current hour highlighted · 00:00 at top
            </p>
            <ActivityClock data={congestion} currentHour={currentHour} />
            <div className="mt-4 flex justify-center gap-6 text-[10px] font-mono text-[#334155]">
              <span><span style={{ color: '#2DD4BF' }}>■</span> Current hour</span>
              <span><span style={{ color: 'rgba(45,212,191,0.85)' }}>■</span> Peak</span>
              <span><span style={{ color: 'rgba(45,212,191,0.15)' }}>■</span> Low</span>
            </div>
          </section>

          {/* Geographic Spread Radar */}
          <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary mb-1">
              Geographic Spread Score
            </h2>
            <p className="text-[11px] text-[#334155] font-mono mb-4">
              Regional airspace activity 0–100 relative score
            </p>
            <div className="h-[260px]">
              <ResponsiveContainer width="100%" height="100%">
                <RadarChart data={radarData} margin={{ top: 8, right: 24, bottom: 8, left: 24 }}>
                  <PolarGrid stroke="#1C2A40" />
                  <PolarAngleAxis dataKey="region"
                    tick={{ fill: '#64748B', fontSize: 9, fontFamily: 'monospace' }} />
                  <PolarRadiusAxis angle={90} domain={[0, 100]} tick={false} axisLine={false} />
                  <Radar name="Activity" dataKey="score" stroke="#2DD4BF" strokeWidth={1.5}
                    fill="#2DD4BF" fillOpacity={0.2} />
                </RadarChart>
              </ResponsiveContainer>
            </div>
          </section>
        </div>

        {/* ── Section 4: Country Speed Ranking ─────────────────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">Fastest Skies</h2>
            <span className="text-[11px] font-mono text-[#334155]">Jet stream tailwinds vary daily</span>
          </div>
          <p className="text-[11px] text-[#334155] font-mono mb-6">
            Average aircraft speed by origin country right now
          </p>

          {countrySpeed.length === 0 ? (
            <p className="text-xs text-[#334155] font-mono">Loading speed data…</p>
          ) : (
            <div className="space-y-2.5">
              {countrySpeed.map(({ country, avg, count, flag }, i) => {
                const pct = Math.round((avg / maxSpeed) * 100)
                // Trend vs "typical" 460 kts cruise average
                const diff   = avg - 460
                const trendC = diff > 0 ? 'text-status-healthy' : diff < 0 ? 'text-error' : 'text-secondary'
                const trendS = diff > 0 ? `↑ +${diff}` : diff < 0 ? `↓ ${diff}` : '→ 0'

                return (
                  <div key={country} className="flex items-center gap-3">
                    <span className="w-6 text-[11px] font-mono text-[#334155] tabular-nums text-right">#{i+1}</span>
                    <span className="material-symbols-outlined text-secondary" style={{ fontSize: 16, minWidth: 20 }}>public</span>
                    <span className="w-32 text-xs text-white truncate shrink-0">{country}</span>
                    <div className="flex-grow h-4 bg-[#1C2A40] rounded overflow-hidden relative">
                      <div className="h-full rounded transition-all duration-500"
                        style={{
                          width: `${pct}%`,
                          background: i < 3
                            ? 'linear-gradient(90deg, #1C7A6C, #2DD4BF)'
                            : 'rgba(45,212,191,0.4)',
                        }} />
                    </div>
                    <span className="w-16 text-right font-mono text-xs text-primary tabular-nums shrink-0">
                      {avg} kts
                    </span>
                    <span className={`w-16 text-right font-mono text-[10px] tabular-nums shrink-0 ${trendC}`}>
                      {trendS} kts
                    </span>
                  </div>
                )
              })}
            </div>
          )}
        </section>

        {/* ── Section 5: Global Airspace Density Heatstrip ─────────────── */}
        <section className="bg-[#0F1624] border border-[#1C2A40] rounded-xl p-6">
          <div className="flex items-center justify-between mb-1">
            <h2 className="text-sm font-semibold uppercase tracking-widest text-secondary">
              Global Airspace Density — Right Now
            </h2>
            <div className="flex items-center gap-3 text-[10px] font-mono">
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'rgba(45,212,191,0.4)' }} />
                <span className="text-secondary">Low</span>
              </span>
              <span className="flex items-center gap-1">
                <span className="inline-block w-2 h-2 rounded-sm" style={{ background: 'rgba(255,107,53,0.7)' }} />
                <span className="text-secondary">Dense</span>
              </span>
            </div>
          </div>
          <p className="text-[11px] text-[#334155] font-mono mb-5">
            Airborne flight density across all longitudes · –180° → +180°
          </p>
          <DensityHeatstrip flights={flights} />
        </section>

      </main>
      
    </div>
  )
}

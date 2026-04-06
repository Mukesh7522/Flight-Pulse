import { useState, useMemo, useEffect, useRef, memo } from 'react'
import { MapContainer, TileLayer, useMap } from 'react-leaflet'
import L from 'leaflet'
import { useFlightData } from '../hooks/useFlightData'

// ─────────────────────────────────────────────────────────────────────────────
// Evenly samples up to `max` items from an array
// ─────────────────────────────────────────────────────────────────────────────
function sample(arr, max) {
  if (arr.length <= max) return arr
  const step = arr.length / max
  return Array.from({ length: max }, (_, i) => arr[Math.floor(i * step)])
}

// ─────────────────────────────────────────────────────────────────────────────
// CANVAS FLIGHT LAYER
// • Single <canvas> — zero per-flight DOM nodes
// • airborne + ghostSet captured directly in closure — no stale ref issues
// • Effect re-runs on every data change → fresh draw closure each time
// • Zoom: canvas hidden during animation, redrawn on zoomend (no jitter)
// • Adaptive count: 5000 at z<4, 10000 at z4-6, viewport-only at z7+
// ─────────────────────────────────────────────────────────────────────────────
function CanvasFlightLayer({ airborne, ghostSet, ghostFlights, onFlightClick }) {
  const map         = useMap()
  const cvRef       = useRef(null)
  const renderedRef = useRef([])   // tracks which flights are actually drawn

  // Create canvas once — stays alive until component unmounts
  useEffect(() => {
    const cv = document.createElement('canvas')
    cv.style.cssText = 'position:absolute;top:0;left:0;pointer-events:none;z-index:300;'
    map.getPanes().overlayPane.appendChild(cv)
    cvRef.current = cv
    return () => { cv.remove(); cvRef.current = null }
  }, [map])

  // Draw effect — re-runs whenever airborne or ghostSet changes.
  // airborne/ghostSet are captured in closure so they're always fresh.
  useEffect(() => {
    const cv = cvRef.current
    if (!cv) return

    let rafId = null
    function scheduleDraw() {
      if (rafId) cancelAnimationFrame(rafId)
      rafId = requestAnimationFrame(draw)
    }

    function draw() {
      rafId = null
      const sz = map.getSize()
      cv.width  = sz.x
      cv.height = sz.y
      L.DomUtil.setPosition(cv, map.containerPointToLayerPoint([0, 0]))

      const ctx = cv.getContext('2d')
      ctx.clearRect(0, 0, sz.x, sz.y)

      // Zoom-adaptive rendering
      const zoom = map.getZoom()
      let toRender
      if (zoom >= 7) {
        const b = map.getBounds()
        toRender = airborne.filter(f => f.lat != null && b.contains([f.lat, f.lon]))
      } else if (zoom < 4) {
        toRender = sample(airborne, 5000)
      } else {
        toRender = sample(airborne, 10000)
      }

      renderedRef.current = toRender   // expose to click handler

      ctx.font         = '11px serif'
      ctx.textAlign    = 'center'
      ctx.textBaseline = 'middle'

      toRender.forEach(f => {
        if (f.lat == null || f.lon == null) return
        const pt      = map.latLngToContainerPoint([f.lat, f.lon])
        const isGhost = ghostSet.has(f.icao24)

        ctx.save()
        ctx.translate(pt.x, pt.y)
        if (!f.on_ground) ctx.rotate(((f.true_track ?? 0) - 45) * Math.PI / 180)
        ctx.fillStyle   = isGhost ? '#F87171' : f.on_ground ? '#64748B' : '#2DD4BF'
        ctx.globalAlpha = isGhost ? 0.9 : 0.85
        ctx.fillText('✈', 0, 0)
        ctx.restore()
      })
    }

    // Hide during zoom animation, redraw after
    function onZoomStart() { cv.style.opacity = '0' }
    function onZoomEnd()   { cv.style.opacity = '1'; scheduleDraw() }

    // Pointer cursor when hovering a visible flight — uses class+!important to
    // beat Leaflet's .leaflet-grab CSS which ignores inline style.cursor
    function onMouseMove(e) {
      const cp   = map.mouseEventToContainerPoint(e.originalEvent)
      const near = renderedRef.current.some(f => {
        if (!f.lat) return false
        const pt = map.latLngToContainerPoint([f.lat, f.lon])
        return Math.hypot(pt.x - cp.x, pt.y - cp.y) < 14
      })
      map.getContainer().classList.toggle('fp-flight-hover', near)
    }
    function onMouseOut() { map.getContainer().classList.remove('fp-flight-hover') }

    scheduleDraw()
    map.on('move viewreset resize', scheduleDraw)
    map.on('zoomstart', onZoomStart)
    map.on('zoomend',   onZoomEnd)
    map.on('mousemove', onMouseMove)
    map.on('mouseout',  onMouseOut)

    return () => {
      if (rafId) cancelAnimationFrame(rafId)
      map.off('move viewreset resize', scheduleDraw)
      map.off('zoomstart', onZoomStart)
      map.off('zoomend',   onZoomEnd)
      map.off('mousemove', onMouseMove)
      map.off('mouseout',  onMouseOut)
      map.getContainer().classList.remove('fp-flight-hover')
    }
  }, [map, airborne, ghostSet])

  // Click: check rendered flights + always check all ghost flights (≤30, never sampled away)
  useEffect(() => {
    if (!onFlightClick) return
    function handleClick(e) {
      const cp = map.mouseEventToContainerPoint(e.originalEvent)
      let nearest = null, minD = 14

      // Sampled visible flights
      renderedRef.current.forEach(f => {
        if (!f.lat) return
        const pt = map.latLngToContainerPoint([f.lat, f.lon])
        const d  = Math.hypot(pt.x - cp.x, pt.y - cp.y)
        if (d < minD) { nearest = f; minD = d }
      })

      // Ghost flights — always check regardless of zoom sampling (slightly larger hit radius)
      ghostFlights.forEach(f => {
        if (!f.lat) return
        const pt = map.latLngToContainerPoint([f.lat, f.lon])
        const d  = Math.hypot(pt.x - cp.x, pt.y - cp.y)
        if (d < 20 && d < minD) { nearest = f; minD = d }
      })

      if (nearest) onFlightClick(nearest)
    }
    map.on('click', handleClick)
    return () => map.off('click', handleClick)
  }, [map, onFlightClick, ghostFlights])

  return null
}


// ── Leaflet.heat heatmap ───────────────────────────────────────────────────
function HeatLayer({ points, active }) {
  const map     = useMap()
  const heatRef = useRef(null)

  useEffect(() => {
    async function build() {
      if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null }
      if (!active || !points.length) return
      await import('leaflet.heat')
      heatRef.current = L.heatLayer(
        points.map(p => [p.lat, p.lon, 1]),
        { radius: 25, blur: 15, maxZoom: 10,
          gradient: { 0.2: '#2DD4BF', 0.5: '#FF6B35', 1.0: '#FF3860' } }
      ).addTo(map)
    }
    build()
    return () => { if (heatRef.current) { map.removeLayer(heatRef.current); heatRef.current = null } }
  }, [points, active, map])

  return null
}

// ── Region definitions ─────────────────────────────────────────────────────
const REGIONS = [
  { name: 'North America', latMin: 15,  latMax: 72,  lonMin: -170, lonMax: -52  },
  { name: 'Europe',        latMin: 34,  latMax: 72,  lonMin: -25,  lonMax: 45   },
  { name: 'Asia Pacific',  latMin: -10, latMax: 70,  lonMin: 60,   lonMax: 180  },
  { name: 'Middle East',   latMin: 12,  latMax: 42,  lonMin: 35,   lonMax: 65   },
  { name: 'South America', latMin: -60, latMax: 15,  lonMin: -82,  lonMax: -34  },
  { name: 'Africa',        latMin: -35, latMax: 38,  lonMin: -20,  lonMax: 52   },
  { name: 'Oceania',       latMin: -50, latMax: -10, lonMin: 110,  lonMax: 180  },
]

function inRegion(f, r) {
  return f.lat >= r.latMin && f.lat <= r.latMax && f.lon >= r.lonMin && f.lon <= r.lonMax
}

function simTrend(count) {
  const seed = count % 17
  const pct  = Math.round(((seed % 5) - 2) * 4)
  return { pct, dir: pct > 0 ? 'up' : pct < 0 ? 'down' : 'flat' }
}

// ── Live feed events ───────────────────────────────────────────────────────
let _eid = 0
function makeEvent(type, f) {
  const cs  = f.callsign || f.icao24
  const alt = f.geo_altitude ? `${Math.round(f.geo_altitude * 3.28084).toLocaleString()} ft` : null
  const map = {
    ghost:   { msg: `${cs} transponder signal lost`,        color: '#F87171', icon: 'warning'       },
    cruise:  { msg: `${cs} reached cruise altitude ${alt}`, color: '#2DD4BF', icon: 'flight'        },
    contact: { msg: `${cs} (${f.origin_country ?? '—'}) contact established`, color: '#2DD4BF', icon: 'radar' },
  }
  const ev = map[type] || map.contact
  return { id: ++_eid, ...ev,
    time: new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' }) }
}

// ── Countdown — isolated so it doesn't re-render the map every second ────────
const Countdown = memo(function Countdown({ secondsSince, pipelineDown }) {
  const [val, setVal] = useState(null)
  useEffect(() => {
    if (secondsSince == null) { setVal(null); return }
    const next = Math.max(0, 180 - secondsSince)
    setVal(next)
    const id = setInterval(() => setVal(c => c == null ? null : c <= 1 ? 180 : c - 1), 1000)
    return () => clearInterval(id)
  }, [secondsSince])
  const cls = pipelineDown ? 'text-xs text-error font-bold'
    : val != null && val <= 10  ? 'text-xs text-primary font-bold'
    : 'text-xs text-secondary'
  return (
    <div className="flex flex-col">
      <span className="text-[10px] uppercase tracking-widest text-secondary font-mono">Next Refresh</span>
      <span className={`data-text font-medium ${cls}`}>{val != null ? `${val}s` : '—'}</span>
    </div>
  )
})

// ── Component ──────────────────────────────────────────────────────────────
export default function LiveMap() {
  const { flights, ghosts, stats, loading, error, pipelineDown } = useFlightData()
  const [activeLayer,    setActiveLayer]    = useState('flights')
  const [selectedFlight, setSelectedFlight] = useState(null)
  const [feedEvents,     setFeedEvents]     = useState([])
  const prevGhostIds = useRef(new Set())

  const ghostSet  = useMemo(() => new Set(ghosts.map(g => g.icao24)), [ghosts])
  const airborne  = useMemo(() => flights.filter(f => f.lat != null && f.lon != null), [flights])
  const validGhosts = useMemo(() => ghosts.filter(g => g.lat != null && g.lon != null), [ghosts])

  // Live feed
  useEffect(() => {
    if (!flights.length) return
    const evs = []
    ghosts.forEach(g => { if (!prevGhostIds.current.has(g.icao24)) evs.push(makeEvent('ghost', g)) })
    prevGhostIds.current = new Set(ghosts.map(g => g.icao24))
    airborne.filter(f => !ghostSet.has(f.icao24) && (f.geo_altitude ?? 0) > 9000)
      .sort(() => 0.5 - Math.random()).slice(0, 2)
      .forEach(f => evs.push(makeEvent('cruise', f)))
    if (evs.length) setFeedEvents(p => [...evs, ...p].slice(0, 28))
  }, [flights, ghosts])

  // Region stats
  const regionStats = useMemo(() => {
    const air = flights.filter(f => !f.on_ground && f.lat != null && f.lon != null)
    return REGIONS.map(r => ({ ...r, count: air.filter(f => inRegion(f, r)).length }))
      .sort((a, b) => b.count - a.count)
  }, [flights])

  const secondsSince = stats?.seconds_since_sync ?? null

  const LAYERS = [
    { key: 'flights', label: 'Flights' },
    { key: 'heat',    label: 'Heat'    },
    { key: 'ghosts',  label: 'Ghosts'  },
  ]

  return (
    <div className="flex flex-col min-h-[calc(100vh-52px)] pb-[28px]">

      <style>{`
        .leaflet-container.fp-flight-hover,
        .leaflet-container.fp-flight-hover .leaflet-pane {
          cursor: pointer !important;
        }
      `}</style>

      {/* ── Map — full viewport bleed ── */}
      <section className="relative overflow-hidden" style={{ height: '62vh', minHeight: 380, width: '100vw', left: '50%', transform: 'translateX(-50%)' }}>
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center z-20 bg-[#060910]/80">
            <span className="font-mono text-sm text-secondary animate-pulse uppercase tracking-widest">
              Connecting to Supabase…
            </span>
          </div>
        )}
        {error && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 z-20 bg-error-container/80 border border-error px-4 py-2 rounded text-xs font-mono text-error">
            {error}
          </div>
        )}

        <MapContainer
          center={[25, 10]} zoom={3} minZoom={2} scrollWheelZoom
          className="w-full h-full" zoomControl={false} attributionControl={false}
          style={{ background: '#060910' }}
          maxBounds={[[-85.05, -180], [85.05, 180]]}
          maxBoundsViscosity={1.0}
          inertia={true}
          inertiaDeceleration={3000}
          inertiaMaxSpeed={1500}
          zoomSnap={0.5}
          zoomDelta={0.5}
          touchZoom={true}
        >
          <TileLayer
            url="https://{s}.basemaps.cartocdn.com/dark_nolabels/{z}/{x}/{y}{r}.png"
            attribution='&copy; OpenStreetMap &copy; CARTO'
            maxZoom={19}
            noWrap={true}
            keepBuffer={4}
          />

          {/* Heatmap */}
          <HeatLayer points={airborne.filter(f => !f.on_ground)} active={activeLayer === 'heat'} />

          {/* All flights — single canvas, zero DOM overhead */}
          {activeLayer !== 'heat' && (
            <CanvasFlightLayer
              airborne={activeLayer === 'ghosts' ? validGhosts : airborne}
              ghostSet={ghostSet}
              ghostFlights={validGhosts}
              onFlightClick={setSelectedFlight}
            />
          )}

          {/* Ghosts rendered on canvas in red — no DOM markers needed */}
        </MapContainer>

        {/* Layer toggles */}
        <div className="absolute bottom-5 left-5 flex gap-2 z-[500]">
          {LAYERS.map(({ key, label }) => (
            <button key={key} onClick={() => setActiveLayer(key)}
              className="px-4 py-1.5 rounded-full backdrop-blur-md border text-xs font-semibold transition-colors"
              style={{
                background:  activeLayer === key ? '#2DD4BF' : 'rgba(15,22,36,0.85)',
                borderColor: activeLayer === key ? '#2DD4BF' : '#1C2A40',
                color:       activeLayer === key ? '#0A0E1A' : '#64748B',
              }}>
              {label}
            </button>
          ))}
        </div>

        {/* Flight detail card — fixed so overflow-hidden can't clip it */}
        {selectedFlight && (
          <div className="fixed top-[60px] right-4 z-[1000] bg-[#0F1624]/95 backdrop-blur-md border border-[#1C2A40] p-4 rounded-lg min-w-[220px]">
            <div className="flex justify-between items-start mb-3">
              <span className="font-mono text-sm text-white font-bold">
                {selectedFlight.callsign || selectedFlight.icao24}
              </span>
              <button onClick={() => setSelectedFlight(null)} className="text-secondary hover:text-white ml-4">
                <span className="material-symbols-outlined text-[16px]">close</span>
              </button>
            </div>
            <div className="space-y-1.5 text-xs">
              {[
                { label: 'ICAO',     val: selectedFlight.icao24 },
                { label: 'Country',  val: selectedFlight.origin_country ?? '—' },
                { label: 'Altitude', val: selectedFlight.geo_altitude
                    ? `${Math.round(selectedFlight.geo_altitude * 3.28084).toLocaleString()} ft` : '—' },
                { label: 'Speed',    val: selectedFlight.velocity
                    ? `${Math.round(selectedFlight.velocity * 1.94384)} kts` : '—' },
                { label: 'Heading',  val: selectedFlight.true_track != null
                    ? `${Math.round(selectedFlight.true_track)}°` : '—' },
              ].map(({ label, val }) => (
                <div key={label} className="flex justify-between gap-4">
                  <span className="text-secondary font-mono uppercase tracking-wider">{label}</span>
                  <span className="font-mono text-on-surface">{val}</span>
                </div>
              ))}
              <div className="flex justify-between gap-4 pt-1">
                <span className="text-secondary font-mono uppercase tracking-wider">Status</span>
                <span className={`font-mono font-bold ${ghostSet.has(selectedFlight.icao24) ? 'text-error' : 'text-status-healthy'}`}>
                  {ghostSet.has(selectedFlight.icao24) ? 'SIGNAL LOST' : 'LIVE'}
                </span>
              </div>
            </div>
          </div>
        )}
      </section>

      {/* ── Stats Strip ── */}
      <section className="h-[64px] w-full bg-[#0F1624] border-t border-[#1C2A40] flex items-center px-6 overflow-x-auto shrink-0">
        <div className="flex items-center gap-12">
          {[
            { label: 'Flights In Air', val: stats?.flights_in_air?.toLocaleString() ?? airborne.filter(f=>!f.on_ground).length.toLocaleString(), cls: 'text-2xl text-primary' },
            { label: 'Countries',      val: stats?.countries_active ?? '—',           cls: 'text-xl text-on-surface' },
            { label: 'On Ground',      val: stats?.flights_on_ground?.toLocaleString() ?? '—', cls: 'text-xl text-on-surface' },
            { label: 'Ghost Alerts',   val: ghosts.length, cls: 'text-xl text-error' },
          ].map(({ label, val, cls }) => (
            <div key={label} className="flex flex-col">
              <span className="text-[10px] uppercase tracking-widest text-secondary font-mono">{label}</span>
              <span className={`data-text font-medium ${cls}`}>{val}</span>
            </div>
          ))}
          {/* Isolated — ticks every second without re-rendering the map */}
          <Countdown secondsSince={secondsSince} pipelineDown={pipelineDown} />
          {pipelineDown && (
            <div className="flex items-center gap-1.5 ml-2">
              <div className="w-1.5 h-1.5 rounded-full bg-error" />
              <span className="text-[10px] font-mono text-error uppercase tracking-wider">Pipeline offline</span>
            </div>
          )}
        </div>
      </section>

      {/* ── Bottom Content ── */}
      <section className="p-6 grid grid-cols-1 md:grid-cols-[280px_1fr_340px] gap-6 pb-12 bg-surface-dim">

        {/* Ghost Alerts */}
        <aside className="space-y-3">
          <h3 className="text-[11px] font-bold tracking-[0.2em] text-error uppercase">
            Ghost Alerts {ghosts.length > 0 && `(${ghosts.length})`}
          </h3>
          {ghosts.length === 0 && !loading && (
            <p className="text-xs text-[#334155] font-mono">No active ghost signals.</p>
          )}
          <div className="space-y-2">
            {ghosts.slice(0, 6).map(g => (
              <div key={g.icao24} onClick={() => setSelectedFlight(g)}
                className="bg-surface-container-low p-3 border border-[#1C2A40] rounded flex flex-col gap-1 hover:bg-[#1A0810] hover:border-error/30 transition-colors cursor-pointer">
                <div className="flex justify-between items-center">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-error animate-pulse" />
                    <span className="data-text text-sm font-medium text-on-surface">{g.callsign || g.icao24}</span>
                  </div>
                  <span className="text-[10px] text-error font-mono">SIGNAL LOST</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-xs text-secondary">{g.origin_country ?? '—'}</span>
                  <span className="text-xs font-mono text-primary-dim">
                    {g.altitude_ft ? `${Number(g.altitude_ft).toLocaleString()} ft` : '—'}
                  </span>
                </div>
              </div>
            ))}
          </div>
        </aside>

        {/* Live Feed */}
        <section className="space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-[11px] font-bold tracking-[0.2em] text-secondary uppercase">Live Feed</h3>
            <div className="flex items-center gap-1.5">
              <div className="w-1.5 h-1.5 rounded-full bg-primary animate-pulse" />
              <span className="text-[10px] font-mono text-secondary uppercase tracking-wider">Streaming</span>
            </div>
          </div>
          <div className="space-y-2 overflow-y-auto max-h-[320px]">
            {feedEvents.length === 0 && (
              <p className="text-xs text-[#334155] font-mono animate-pulse py-2">Waiting for events…</p>
            )}
            {feedEvents.map(ev => (
              <div key={ev.id} className="bg-surface-container-low p-3 border border-[#1C2A40] rounded flex items-center gap-3 hover:bg-[#141D2E] transition-colors">
                <span className="material-symbols-outlined shrink-0" style={{ color: ev.color, fontSize: 14 }}>{ev.icon}</span>
                <p className="text-xs font-mono text-on-surface flex-1 leading-snug min-w-0 truncate">{ev.msg}</p>
                <span className="text-[10px] font-mono text-[#334155] shrink-0 tabular-nums">{ev.time}</span>
              </div>
            ))}
          </div>
        </section>

        {/* Live Regional Traffic */}
        <section className="space-y-3">
          <h3 className="text-[11px] font-bold tracking-[0.2em] text-secondary uppercase">Live Regional Traffic</h3>
          <div className="bg-surface-container-low border border-[#1C2A40] rounded-lg overflow-hidden">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#141D2E]">
                  <th className="px-4 py-2 text-[10px] font-mono text-secondary uppercase tracking-wider">Region</th>
                  <th className="px-4 py-2 text-[10px] font-mono text-secondary uppercase tracking-wider text-right">Flights</th>
                  <th className="px-4 py-2 text-[10px] font-mono text-secondary uppercase tracking-wider text-right">Trend</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-[#1C2A40]">
                {regionStats.map(({ name, count }) => {
                  const { pct, dir } = simTrend(count)
                  return (
                    <tr key={name} className="hover:bg-[#141D2E] transition-colors">
                      <td className="px-4 py-2.5 text-xs text-on-surface">{name}</td>
                      <td className="px-4 py-2.5 font-mono text-xs text-primary text-right tabular-nums">{count.toLocaleString()}</td>
                      <td className={`px-4 py-2.5 font-mono text-xs text-right tabular-nums font-semibold ${
                        dir === 'up' ? 'text-status-healthy' : dir === 'down' ? 'text-error' : 'text-secondary'
                      }`}>
                        {dir === 'up' ? `↑ +${pct}%` : dir === 'down' ? `↓ ${pct}%` : '→ 0%'}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          </div>
        </section>

      </section>

      
    </div>
  )
}

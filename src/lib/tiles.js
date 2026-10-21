/**
 * Basemap providers, tried in order. LiveMap switches to the next one when
 * tiles start failing (provider outage, block, quota, key now required, …).
 *
 * To pin a different basemap without a code change, set VITE_TILE_URL
 * (e.g. a MapTiler/Stadia URL with your key) — it becomes the first choice.
 */
const custom = import.meta.env.VITE_TILE_URL

export const TILE_PROVIDERS = [
  ...(custom
    ? [{ id: 'custom', url: custom, attribution: import.meta.env.VITE_TILE_ATTRIBUTION || '', maxNativeZoom: 18 }]
    : []),
  {
    id: 'esri-dark-gray',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}',
    attribution: 'Tiles &copy; Esri',
    maxNativeZoom: 16,
  },
  {
    // Light OSM tiles darkened with a CSS filter (see .fp-tiles-dark in index.css)
    id: 'osm-darkened',
    url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
    attribution: '&copy; OpenStreetMap contributors',
    maxNativeZoom: 19,
    className: 'fp-tiles-dark',
  },
]

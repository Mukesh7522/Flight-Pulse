import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import LiveMap from './pages/LiveMap'
import Analytics from './pages/Analytics'
import Anomalies from './pages/Anomalies'
import Insights from './pages/Insights'
import ErrorBoundary from './components/ErrorBoundary'
import { configError } from './lib/supabase'

export default function App() {
  if (configError) {
    return (
      <div className="min-h-screen bg-surface-dim text-on-surface p-8 font-mono text-sm">
        <p className="text-error font-bold uppercase tracking-widest mb-2">Configuration error</p>
        <p>{configError}</p>
      </div>
    )
  }

  return (
    <BrowserRouter>
      <div className="min-h-screen bg-surface-dim text-on-surface">
        <Navbar />
        <ErrorBoundary>
        <Routes>
          <Route path="/"           element={<LiveMap />} />
          <Route path="/analytics"  element={<Analytics />} />
          <Route path="/anomalies"  element={<Anomalies />} />
          <Route path="/insights"   element={<Insights />} />
        </Routes>
        </ErrorBoundary>
      </div>
    </BrowserRouter>
  )
}

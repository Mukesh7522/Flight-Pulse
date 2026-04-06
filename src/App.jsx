import { BrowserRouter, Routes, Route } from 'react-router-dom'
import Navbar from './components/Navbar'
import LiveMap from './pages/LiveMap'
import Analytics from './pages/Analytics'
import Anomalies from './pages/Anomalies'
import Insights from './pages/Insights'

export default function App() {
  return (
    <BrowserRouter>
      <div className="min-h-screen bg-surface-dim text-on-surface">
        <Navbar />
        <Routes>
          <Route path="/"           element={<LiveMap />} />
          <Route path="/analytics"  element={<Analytics />} />
          <Route path="/anomalies"  element={<Anomalies />} />
          <Route path="/insights"   element={<Insights />} />
        </Routes>
      </div>
    </BrowserRouter>
  )
}

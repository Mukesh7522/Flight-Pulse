import { NavLink } from 'react-router-dom'
import logoIcon from '../assets/logo-icon.png'

const NAV_LINKS = [
  { to: '/',          label: 'Map'       },
  { to: '/analytics', label: 'Analytics' },
  { to: '/anomalies', label: 'Anomalies' },
  { to: '/insights',  label: 'Insights'  },
]

export default function Navbar() {
  return (
    <nav className="h-[52px] w-full sticky top-0 z-50 bg-[#0A0E1A] border-b border-[#1C2A40] flex justify-between items-center px-6">
      {/* Logo */}
      <div className="flex items-center gap-6">
        <img src={logoIcon} alt="FlightPulse" className="h-12 w-auto" />
        <span className="text-white font-bold text-lg tracking-wide">Flight Pulse</span>

        {/* Nav links */}
        <div className="hidden md:flex items-center h-[52px] text-sm font-semibold tracking-tight">
          {NAV_LINKS.map(({ to, label }) => (
            <NavLink
              key={to}
              to={to}
              end={to === '/'}
              className={({ isActive }) =>
                isActive
                  ? 'text-white border-b-2 border-primary h-full flex items-center px-4'
                  : 'text-[#64748B] hover:text-white transition-colors h-full flex items-center px-4'
              }
            >
              {label}
            </NavLink>
          ))}
        </div>
      </div>

    </nav>
  )
}

export default function Footer() {
  return (
    <footer className="fixed bottom-0 w-full h-[28px] z-50 bg-[#060910] border-t border-[#1C2A40] flex justify-between items-center px-4 font-mono text-[11px] uppercase tracking-wider">
      <div className="text-secondary">FlightPulse Global · v1.0.0</div>
      <div className="flex gap-6">
        <span className="text-status-healthy flex items-center gap-1">
          Ingestion
          <span className="material-symbols-outlined text-[10px]">check</span>
        </span>
        <span className="text-status-healthy flex items-center gap-1">
          dbt
          <span className="material-symbols-outlined text-[10px]">check</span>
        </span>
        <span className="text-status-healthy flex items-center gap-1">
          API
          <span className="material-symbols-outlined text-[10px]">check</span>
        </span>
      </div>
    </footer>
  )
}

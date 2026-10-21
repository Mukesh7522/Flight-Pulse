import { Component } from 'react'

/** Catches render errors so one broken page doesn't blank the whole app. */
export default class ErrorBoundary extends Component {
  state = { error: null }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    console.error('[FlightPulse] render error:', error, info?.componentStack)
  }

  render() {
    if (!this.state.error) return this.props.children
    return (
      <div className="mx-auto max-w-xl p-8 mt-16 border border-error rounded bg-error-container/30 font-mono text-sm text-error">
        <p className="font-bold uppercase tracking-widest mb-2">Something went wrong</p>
        <p className="text-on-surface mb-4">{String(this.state.error?.message ?? this.state.error)}</p>
        <button
          className="px-3 py-1 border border-error rounded hover:bg-error/10"
          onClick={() => window.location.reload()}
        >
          Reload
        </button>
      </div>
    )
  }
}

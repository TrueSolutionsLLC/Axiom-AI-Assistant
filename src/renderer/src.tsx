import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import './styles.css';
import './referenceMod.css';
import './hudPanels.css';
import './referenceMasks.css';
import './settingsPolish.css';
import './runtimeCore.css';
import './memoryFabric.css';
import './desktopGraph.css';
import './operations.css';
import './systemDiagnostics.css';
import './operationalTruth.css';
import './readability.css';
import './commandCenter.css';

// App is a single large component tree (camera/face tracking, WebRTC, voice
// inference, dozens of effects) with no fallback of its own — before this,
// any render-time exception anywhere in it white-screened the whole app
// with zero recovery for a non-technical user except killing the process.
// Inline styles only, deliberately: this has to render correctly even if
// the reason App crashed is a CSS-cascade problem in one of the 13 files
// above, so it can't depend on any of their classes.
class ErrorBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state: { error: Error | null } = { error: null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error, info: React.ErrorInfo) {
    try { window.axiom?.reportRendererCrash?.(error.message, error.stack, info.componentStack ?? undefined); } catch { /* best effort only */ }
  }
  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div style={{ position: 'fixed', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#03080a', color: '#d8f4f5', fontFamily: 'Consolas, monospace', padding: 32, textAlign: 'center' }}>
        <div style={{ maxWidth: 480 }}>
          <h1 style={{ fontSize: 18, letterSpacing: '0.08em', marginBottom: 12 }}>AXIOM HIT AN UNEXPECTED ERROR</h1>
          <p style={{ fontSize: 13, opacity: 0.8, marginBottom: 20, lineHeight: 1.5 }}>{this.state.error.message || 'Something in the interface crashed.'}</p>
          <button
            onClick={() => window.location.reload()}
            style={{ background: 'rgba(70,232,255,0.12)', border: '1px solid rgba(70,232,255,0.4)', color: '#46e8ff', padding: '10px 20px', borderRadius: 6, cursor: 'pointer', fontFamily: 'inherit', fontSize: 13, letterSpacing: '0.06em' }}
          >
            RELOAD
          </button>
        </div>
      </div>
    );
  }
}

createRoot(document.getElementById('root')!).render(<React.StrictMode><ErrorBoundary><App /></ErrorBoundary></React.StrictMode>);

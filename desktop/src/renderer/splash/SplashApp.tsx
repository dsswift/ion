import React from 'react'
import type { StartupState } from '../../shared/startup-state'
import heroImage from './assets/ion-engine-hero-web.jpg'
import ionIcon from './assets/ion-icon.png'

interface Props {
  state: StartupState
}

export function SplashApp({ state }: Props): React.JSX.Element {
  const failed = state.mode === 'error' || state.error !== null
  const authenticating = state.mode === 'authentication'

  return (
    <main className="splash-card">
      <img className="splash-hero" src={heroImage} alt="" />
      <div className="splash-scrim" />
      <section className="splash-content">
        <header className="splash-heading">
          <img className="splash-icon" src={ionIcon} alt="" />
          <div>
            <div className="splash-brand">Ion Studio</div>
            <div className="splash-version">Version {state.appVersion}</div>
          </div>
        </header>

        <div className="splash-bottom">
          {authenticating ? (
            <div className="splash-auth-panel">
              <div className="splash-auth-title">Sign in to continue</div>
              <div className="splash-auth-copy">Your organization requires sign-in before Ion Studio can load.</div>
              <button
                className="splash-primary-action"
                type="button"
                disabled={state.authenticationBusy}
                onClick={() => { void window.ionStartup.authenticate() }}
              >
                {state.authenticationBusy ? 'Waiting for browser…' : 'Sign in'}
              </button>
              {state.authenticationError && <div className="splash-auth-error" role="alert">{state.authenticationError}</div>}
            </div>
          ) : (
            <div className="splash-progress-panel">
              <div className={`splash-status${failed ? ' splash-error' : ''}`}>
                {failed ? state.error : state.status}
              </div>
              {!failed && <div className="splash-track" aria-label="Loading"><div className="splash-indicator" /></div>}
              {failed && (
                <div className="splash-actions">
                  <button type="button" onClick={() => window.ionStartup.relaunch()}>Restart Ion</button>
                  <button type="button" onClick={() => window.ionStartup.quit()}>Quit</button>
                </div>
              )}
            </div>
          )}
        </div>
      </section>
    </main>
  )
}

import React, { useEffect, useState } from 'react'
import { createRoot } from 'react-dom/client'
import type { StartupState } from '../../shared/startup-state'
import { SplashApp } from './SplashApp'
import './splash.css'

declare global {
  interface Window {
    ionStartup: {
      getState: () => Promise<StartupState>
      onState: (callback: (state: StartupState) => void) => () => void
      authenticate: () => Promise<{ ok: boolean; error?: string }>
      relaunch: () => void
      quit: () => void
    }
  }
}

function Root(): React.JSX.Element {
  const [state, setState] = useState<StartupState>({
    sequence: -1,
    target: null,
    source: 'main',
    status: 'Starting Ion…',
    mode: 'loading',
    authenticationBusy: false,
    authenticationError: null,
    appVersion: '',
    ownerReady: false,
    studioReady: false,
    error: null,
  })
  useEffect(() => {
    const apply = (next: StartupState) => setState((current) => next.sequence > current.sequence ? next : current)
    const off = window.ionStartup.onState(apply)
    void window.ionStartup.getState().then(apply)
    return off
  }, [])
  return <SplashApp state={state} />
}

createRoot(document.getElementById('root')!).render(<Root />)

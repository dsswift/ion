import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { rootErrorOptions } from './react-root-errors'
import { TypographySync } from './TypographySync'
import { WindowVisibilityGate } from './WindowVisibilityGate'
import './index.css'

// Root error hooks: capture componentStack for scheduler-thrown errors
// (React #185) that error boundaries cannot catch — see react-root-errors.ts.
ReactDOM.createRoot(document.getElementById('root')!, rootErrorOptions('overlay')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <TypographySync />
      <WindowVisibilityGate />
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)

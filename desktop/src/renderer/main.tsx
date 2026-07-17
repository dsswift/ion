import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { rootErrorOptions } from './react-root-errors'
import './index.css'

// Root error hooks: capture componentStack for scheduler-thrown errors
// (React #185) that error boundaries cannot catch — see react-root-errors.ts.
ReactDOM.createRoot(document.getElementById('root')!, rootErrorOptions('overlay')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <App />
    </RootErrorBoundary>
  </React.StrictMode>
)

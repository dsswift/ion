/**
 * Entry point for the Agent Team Visualizer renderer (second window).
 * Mounts the ATV shell; all simulation state lives outside React.
 *
 * The global stylesheet import is LOAD-BEARING: every shared component
 * (TabStrip, ConversationView, InputBar…) styles itself with the same
 * Tailwind utilities and global rules the overlay entry loads. Without it
 * the shell renders as unstyled HTML.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { AtvShell } from './AtvShell'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { rootErrorOptions } from '../react-root-errors'

const container = document.getElementById('root')
if (!container) {
  throw new Error('ATV renderer: #root container missing from atv.html')
}
// Root error hooks: capture componentStack for scheduler-thrown errors
// (React #185) that error boundaries cannot catch — see react-root-errors.ts.
createRoot(container, rootErrorOptions('atv')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <AtvShell />
    </RootErrorBoundary>
  </React.StrictMode>,
)

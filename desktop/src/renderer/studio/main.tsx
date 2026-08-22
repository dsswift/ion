/**
 * Entry point for the Ion Studio renderer (second window).
 * Mounts the Studio shell; all simulation state lives outside React.
 *
 * The global stylesheet import is LOAD-BEARING: every shared component
 * (TabStrip, ConversationView, InputBar…) styles itself with the same
 * Tailwind utilities and global rules the overlay entry loads. Without it
 * the shell renders as unstyled HTML.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { StudioShell } from './StudioShell'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { rootErrorOptions } from '../react-root-errors'
import { TypographySync } from '../TypographySync'
import { WindowVisibilityGate } from '../WindowVisibilityGate'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Studio renderer: #root container missing from studio.html')
}
// Root error hooks: capture componentStack for scheduler-thrown errors
// (React #185) that error boundaries cannot catch — see react-root-errors.ts.
createRoot(container, rootErrorOptions('studio')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <TypographySync />
      <WindowVisibilityGate />
      <StudioShell />
    </RootErrorBoundary>
  </React.StrictMode>,
)

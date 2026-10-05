/**
 * The Fleet Hub portal's entry: the page a Fleet Hub serves. It shows every
 * server that reports to the hub and runs the hub's actions on them. It is
 * not Studio: it holds no conversations and connects to no server itself.
 */
import React from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import { PopoverLayerProvider } from './components/PopoverLayer'
import { RootErrorBoundary } from './components/RootErrorBoundary'
import { rootErrorOptions } from './react-root-errors'
import { HubApp } from './hub/HubApp'

const container = document.getElementById('root')
if (!container) {
  throw new Error('Hub portal: #root container missing from hub.html')
}

createRoot(container, rootErrorOptions('hub')).render(
  <React.StrictMode>
    <RootErrorBoundary>
      <PopoverLayerProvider>
        <HubApp />
      </PopoverLayerProvider>
    </RootErrorBoundary>
  </React.StrictMode>,
)

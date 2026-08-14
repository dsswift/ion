import React from 'react'
import { createRoot } from 'react-dom/client'
import '../index.css'
import { RootErrorBoundary } from '../components/RootErrorBoundary'
import { rootErrorOptions } from '../react-root-errors'
import { WorktreeOverlapApp } from './WorktreeOverlapApp'

const root = document.getElementById('root')
if (!root) throw new Error('Worktree overlap renderer: #root missing')

createRoot(root, rootErrorOptions('worktree-overlap')).render(
  <React.StrictMode><RootErrorBoundary><WorktreeOverlapApp /></RootErrorBoundary></React.StrictMode>,
)

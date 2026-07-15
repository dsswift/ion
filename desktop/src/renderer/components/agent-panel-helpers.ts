// Pure agent-state helpers moved to renderer/lib so non-component surfaces
// (e.g. the Agent Team Visualizer renderer) can import them without pulling
// in component code. This module remains as a re-export so existing
// component imports keep working.
export * from '../lib/agent-helpers'

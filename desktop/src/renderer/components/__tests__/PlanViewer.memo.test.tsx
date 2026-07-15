// @vitest-environment jsdom
//
// PlanViewer is wrapped in React.memo so an ancestor re-render (e.g. a
// status-bar update while the plan window is open) does not force react-markdown
// to re-parse the whole plan — the cause of scroll stutter. Call sites pass a
// referentially stable onClose so the memo actually skips. This guards the
// wrapper against accidental removal.
import { describe, it, expect } from 'vitest'
import { PlanViewer } from '../PlanViewer'

describe('PlanViewer', () => {
  it('is wrapped in React.memo', () => {
    expect((PlanViewer as any).$$typeof).toBe(Symbol.for('react.memo'))
  })
})

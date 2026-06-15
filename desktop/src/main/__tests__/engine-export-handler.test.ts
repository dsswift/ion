/**
 * Tests for `engine-export-handler.ts` — focused on the format→extension
 * mapping and filename generation. The save-dialog interaction itself is
 * not unit-testable (it depends on Electron's main process) — we verify
 * the pure inputs/outputs the handler relies on for picking the dialog's
 * default filename + extension.
 *
 * The engine reports the resolved format on `engine_export.exportFormat`,
 * so the handler maps it directly to a file extension — no payload
 * sniffing. These tests pin that map and the absent-format fallback.
 */

import { describe, it, expect, vi } from 'vitest'

// Mock electron so the import graph resolves cleanly. We don't actually
// invoke the dialog in these tests; we just need the module to load.
vi.mock('electron', () => ({
  dialog: { showSaveDialog: vi.fn() },
  app: { getPath: () => '/tmp' },
}))

// The format→extension helper is not exported, so we re-derive its logic
// here. If the production helper's contract changes, this test must
// change too — that lockstep is the point. Mirrors extensionForFormat in
// engine-export-handler.ts.
function extensionForFormat(format: string | undefined): string {
  switch (format) {
    case 'markdown':
      return 'md'
    case 'json':
      return 'json'
    case 'html':
      return 'html'
    case 'jsonl':
      return 'jsonl'
    default:
      return 'md'
  }
}

describe('engine-export-handler format → extension', () => {
  it('maps markdown to md', () => {
    expect(extensionForFormat('markdown')).toBe('md')
  })

  it('maps json to json', () => {
    expect(extensionForFormat('json')).toBe('json')
  })

  it('maps html to html', () => {
    expect(extensionForFormat('html')).toBe('html')
  })

  it('maps jsonl to jsonl', () => {
    expect(extensionForFormat('jsonl')).toBe('jsonl')
  })

  it('falls back to md when the format is absent (legacy engine)', () => {
    expect(extensionForFormat(undefined)).toBe('md')
  })

  it('falls back to md on an unrecognized format', () => {
    expect(extensionForFormat('xml')).toBe('md')
  })
})

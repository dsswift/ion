// @vitest-environment jsdom
/**
 * The browser-host path for useFileEditorContent: the fs verbs are bridged
 * over the studio-wire, so a browser Studio client loads and watches a file
 * exactly like Electron.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import React from 'react'
import { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { FileEditorTab } from '@ion/server/store/sessionStore'

const { fsReadFile, fsWatchFile, fsUnwatchFile, fsWriteFile, fsSaveDialog, onFileChanged, capabilities } = vi.hoisted(() => ({
  fsReadFile: vi.fn(),
  fsWatchFile: vi.fn().mockResolvedValue({ ok: true }),
  fsUnwatchFile: vi.fn().mockResolvedValue(undefined),
  fsWriteFile: vi.fn().mockResolvedValue({ ok: true }),
  fsSaveDialog: vi.fn().mockResolvedValue({ filePath: null }),
  onFileChanged: vi.fn(() => () => undefined),
  capabilities: vi.fn<() => string[]>(),
}))

vi.mock('../../host/host-instance', () => ({
  host: { shell: { fsReadFile, fsWatchFile, fsUnwatchFile, fsWriteFile, fsSaveDialog, onFileChanged }, capabilities },
}))

interface FakeEditorState {
  files: FileEditorTab[]
}

let fileEditorStates: Map<string, FakeEditorState>
const markEditorSaved = vi.fn()

vi.mock('@ion/server/store/sessionStore', () => {
  const listeners = new Set<() => void>()
  const getState = () => ({ fileEditorStates, markEditorSaved })
  const setState = (updater: (s: ReturnType<typeof getState>) => Partial<ReturnType<typeof getState>>) => {
    const patch = updater(getState())
    if (patch.fileEditorStates) fileEditorStates = patch.fileEditorStates
    listeners.forEach((l) => l())
  }
  const useSessionStore = Object.assign(
    (selector: (s: ReturnType<typeof getState>) => unknown) => selector(getState()),
    { getState, setState, subscribe: (l: () => void) => { listeners.add(l); return () => listeners.delete(l) } },
  )
  return { useSessionStore }
})

import { useFileEditorContent } from '../useFileEditorContent'

;(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true

const DIR = '/repo'

function makeFile(overrides: Partial<FileEditorTab> = {}): FileEditorTab {
  return {
    id: 'f1',
    filePath: '/repo/notes.txt',
    fileName: 'notes.txt',
    content: '',
    savedContent: '',
    isDirty: false,
    isReadOnly: false,
    isPreview: false,
    isLoaded: false,
    ...overrides,
  } as FileEditorTab
}

function Consumer({ activeFile }: { activeFile: FileEditorTab | null }): null {
  useFileEditorContent({ dir: DIR, activeFile })
  return null
}

function mount(activeFile: FileEditorTab | null): { root: ReturnType<typeof createRoot>; container: HTMLDivElement } {
  const container = document.createElement('div')
  document.body.appendChild(container)
  const root = createRoot(container)
  act(() => {
    root.render(<Consumer activeFile={activeFile} />)
  })
  return { root, container }
}

beforeEach(() => {
  fsReadFile.mockClear()
  fsWatchFile.mockClear()
  fsUnwatchFile.mockClear()
  fsWriteFile.mockClear()
  fsSaveDialog.mockClear()
  onFileChanged.mockClear()
  markEditorSaved.mockClear()
  const file = makeFile()
  fileEditorStates = new Map([[DIR, { files: [file] }]])
})

describe('useFileEditorContent on a browser Studio client', () => {
  it('loads and watches the file through the bridged fs verbs', () => {
    capabilities.mockReturnValue(['terminal', 'git', 'files', 'questions', 'graph'])
    fsReadFile.mockResolvedValue({ content: 'hello' })
    const file = fileEditorStates.get(DIR)!.files[0]!
    mount(file)

    expect(fsReadFile).toHaveBeenCalledWith('/repo/notes.txt')
    expect(fsWatchFile).toHaveBeenCalledWith('/repo/notes.txt')
  })
})

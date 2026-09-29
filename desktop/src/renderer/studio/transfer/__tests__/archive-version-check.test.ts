import { describe, expect, it } from 'vitest'
import type { TransferDescription, TransferPreflight } from '@ion/shared/types-environment-admin'
import { archiveVersionCheck } from '../archive-version-check'

const description = (archiveVersion?: number): TransferDescription => ({ status: 'idle', worktree: null, project: null, ...(archiveVersion ? { archiveVersion } : {}) })
const preflight = (archiveVersion?: number): TransferPreflight => ({ projectDir: null, projectDirs: [], allProjectDirs: [], sourceDirectoryExists: false, hasSourceBranch: false, knownTips: [], worktreeCopy: null, ...(archiveVersion ? { archiveVersion } : {}) })

describe('archiveVersionCheck', () => {
  it('passes when both ends write the same format', () => {
    expect(archiveVersionCheck(description(2), preflight(2), 'this Mac')).toBeNull()
    expect(archiveVersionCheck(description(), preflight(), 'this Mac')).toBeNull()
  })

  // A source that reports nothing predates the field and writes format 1:
  // exactly the server that produced "unsupported transfer.json.version=1".
  it('blocks a source older than the destination, naming the source', () => {
    expect(archiveVersionCheck(description(), preflight(2), 'this Mac')).toMatchObject({ id: 'version', state: 'blocked', label: "The conversation's machine runs an older Ion server" })
  })

  it('blocks a destination older than the source, naming the destination', () => {
    expect(archiveVersionCheck(description(2), preflight(), 'grover')).toMatchObject({ state: 'blocked', label: 'grover runs an older Ion server' })
  })
})

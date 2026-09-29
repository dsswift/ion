/**
 * `fs.*` `studio_action`s — the wire face of `files/file-api.ts`.
 *
 * Reads take `conversations:read`; anything that mutates the filesystem
 * takes `git:write`. That scope is named for repository mutation and is
 * exactly the right bar here: the files these verbs create, rename, and
 * delete ARE the working tree, so a client that may not change the
 * repository may not change its files either.
 *
 * The watch verbs are reads in the permission sense — they observe, they do
 * not mutate — and their change notification rides the
 * `ion:file-changed` studio_event channel.
 */
import type { Scope } from '@ion/shared/studio-wire/types'
import { IPC } from '@ion/shared/types'
import * as fileApi from '../files/file-api'
import { describeFile } from '../files/describe-file'
import { saveAttachmentData } from '../files/save-attachment-data'
import { readFileData } from '../files/read-file-data'
import { resolveFileLink } from '../files/resolve-file-link'
import { searchFiles } from '../files/file-search'
import { searchText } from '../files/text-search'
import { loadProjectStudioConfig, trustProjectQuickTools } from '../project-studio-config'
import { broadcast } from '../broadcast'
import { warn as _warn } from '../logger'
import type { Connection } from './connection'

function warn(msg: string, fields?: Record<string, unknown>): void {
  _warn('file-actions', msg, fields)
}

export type FileActionOutcome =
  | { ok: true; value: unknown }
  | { ok: false; error: { code: string; message: string } }

export interface FileActionSpec {
  requiredScope: Scope
  handler: (conn: Connection, args: unknown[]) => Promise<FileActionOutcome>
}

function wrap(name: string, requiredScope: Scope, run: (args: unknown[]) => unknown): FileActionSpec {
  return {
    requiredScope,
    handler: async (conn, args) => {
      try {
        return { ok: true, value: (await run(args)) ?? null }
      } catch (err) {
        warn('file action threw', { connection_id: conn.id, action: name, error: String(err) })
        return { ok: false, error: { code: 'file_action_failed', message: String(err) } }
      }
    },
  }
}

export const FILE_ACTIONS: Record<string, FileActionSpec> = {
  'fs.readDir': wrap('fs.readDir', 'conversations:read', (args) => fileApi.fsReadDir(args[0])),
  'fs.readFile': wrap('fs.readFile', 'conversations:read', (args) => fileApi.fsReadFile(args[0])),
  'fs.exists': wrap('fs.exists', 'conversations:read', (args) => fileApi.fsExists(args[0])),
  'fs.watchFile': wrap('fs.watchFile', 'conversations:read', (args) =>
    fileApi.fsWatchFile(args[0], (filePath) => broadcast(IPC.FS_FILE_CHANGED, filePath))),
  'fs.unwatchFile': wrap('fs.unwatchFile', 'conversations:read', (args) => fileApi.fsUnwatchFile(args[0])),

  // Describing a file for attachment is a read: it stats the path and, for a
  // small image, builds a preview. Nothing is mutated.
  // The payload may also carry `tabId`; that only routes the call on the
  // client, and the server reads the path alone.
  'fs.attachByPath': wrap('fs.attachByPath', 'conversations:read', (args) =>
    describeFile(String((args[0] as { path?: unknown })?.path ?? args[0]))),
  // A file's raw bytes, so a client can open a copy with its own operating
  // system. A read, capped at the attachment size limit.
  'fs.readFileData': wrap('fs.readFileData', 'conversations:read', (args) => readFileData(args[0])),
  // A path the operator clicked, resolved against this machine's home and
  // the conversation's working directory, and stat'ed. A read.
  'fs.resolveLink': wrap('fs.resolveLink', 'conversations:read', (args) => resolveFileLink(args[0])),

  // The composer's `@file` mention source. Listing names is a read.
  'fs.searchFiles': wrap('fs.searchFiles', 'conversations:read', (args) => searchFiles(args[0])),
  // Workspace Search: literal text across the workspace folders. A read.
  'fs.searchText': wrap('fs.searchText', 'conversations:read', (args) => searchText(args[0])),

  // A project's committed `.ion/studio.json`. Reading it is a read. Trusting
  // its Quick Tools authorises shell commands from a repository, which is the
  // bar running a terminal takes.
  'fs.projectStudioConfig': wrap('fs.projectStudioConfig', 'conversations:read', (args) => loadProjectStudioConfig(args[0])),
  'fs.trustProjectQuickTools': wrap('fs.trustProjectQuickTools', 'terminal:operate', (args) => trustProjectQuickTools(args[0])),

  // Staging bytes the client holds (a browser drop, an oversized paste) as an
  // attachment is part of composing a prompt, so it takes the scope that
  // sending one takes. It writes only under the server's own data directory,
  // never into a working tree, which is why it is not `git:write`.
  'fs.saveAttachmentData': wrap('fs.saveAttachmentData', 'conversations:operate', (args) => saveAttachmentData(args[0])),

  'fs.writeFile': wrap('fs.writeFile', 'git:write', (args) => fileApi.fsWriteFile(args[0])),
  'fs.createDir': wrap('fs.createDir', 'git:write', (args) => fileApi.fsCreateDir(args[0])),
  'fs.createFile': wrap('fs.createFile', 'git:write', (args) => fileApi.fsCreateFile(args[0])),
  'fs.rename': wrap('fs.rename', 'git:write', (args) => fileApi.fsRename(args[0])),
  'fs.delete': wrap('fs.delete', 'git:write', (args) => fileApi.fsDelete(args[0])),
}

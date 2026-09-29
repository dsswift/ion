/**
 * What a main-process crash leaves behind in `desktop.jsonl`.
 *
 * Electron's default for an uncaught exception in main is a dialog and a
 * process that keeps running; for an unhandled rejection it is a console
 * warning. Neither reaches the operator's log file, so the record of a crash
 * lived only in a dialog someone had to be looking at. `desktop/AGENTS.md`
 * told readers that a main-process exception at boot is diagnosed from
 * `desktop.jsonl` -- true only once something writes it there.
 *
 * Installing a handler suppresses Electron's dialog, so this puts the same
 * dialog back. The visible behaviour is unchanged; what is added is the line
 * on disk.
 */
import { dialog } from 'electron'
import { error as _error, flushLogs } from './logger'

const TAG = 'crash'

function error(msg: string, fields?: Record<string, unknown>): void {
  _error(TAG, msg, fields)
}

/** Replaceable for tests, which must not open a real modal. */
let showError: (title: string, content: string) => void = (title, content) => dialog.showErrorBox(title, content)

/** TEST ONLY. */
export function _setShowErrorForTest(fn: ((title: string, content: string) => void) | null): void {
  showError = fn ?? ((title, content) => dialog.showErrorBox(title, content))
}

/**
 * Record unhandled failures in this process.
 *
 * Called first in app start-up, so a throw from any later step is captured.
 * ERROR lines are written synchronously and `flushLogs()` drains everything
 * buffered behind them -- the run-up that explains the crash, which otherwise
 * sits in the logger's 500 ms buffer while the app is wedged.
 */
export function installMainCrashLogging(): void {
  process.on('uncaughtException', (err: Error) => {
    error('uncaught exception in the main process', {
      error: err.message,
      error_name: err.name,
      stack: err.stack ?? '(no stack)',
    })
    flushLogs()
    // Electron shows this itself when no handler is installed. Installing one
    // takes that over, so the operator still sees what happened.
    showError('A JavaScript error occurred in the main process', err.stack ?? err.message)
  })

  process.on('unhandledRejection', (reason: unknown) => {
    const err = reason instanceof Error ? reason : new Error(String(reason))
    error('unhandled promise rejection in the main process', {
      error: err.message,
      error_name: err.name,
      stack: err.stack ?? '(no stack)',
    })
    flushLogs()
  })
}

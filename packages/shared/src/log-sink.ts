/**
 * Where the shared log-shipping stack writes its own operational lines.
 *
 * These modules run in two processes with two different loggers -- the Ion
 * Studio Server's (`server/src/logger.ts`, writing `server.jsonl`) and
 * Electron main's (`desktop/src/main/logger.ts`, writing `desktop.jsonl`) --
 * and the right answer is always "whichever process I am in". A direct import
 * of either would pick one at build time and file the other's lines under the
 * wrong component, which is the defect this whole area exists to fix.
 *
 * So each process registers its own logger once at start-up. Before that, and
 * in a bundle that never registers one (the Studio renderer, which reaches
 * this module only transitively), lines are dropped rather than crashing on a
 * logger that is not there.
 */

export type LogSink = (level: 'TRACE' | 'DEBUG' | 'INFO' | 'WARN' | 'ERROR', tag: string, msg: string, fields?: Record<string, unknown>) => void

/** Dropped, deliberately: a process that has not registered a logger has nowhere to put these. */
const noopSink: LogSink = () => {}

let sink: LogSink = noopSink

/** Register this process's logger. Called once, at start-up, before anything ships. */
export function setLogSink(next: LogSink): void {
  sink = next
}

/** TEST ONLY. */
export function _resetLogSinkForTest(): void {
  sink = noopSink
}

export function log(tag: string, msg: string, fields?: Record<string, unknown>): void {
  sink('INFO', tag, msg, fields)
}
export function debug(tag: string, msg: string, fields?: Record<string, unknown>): void {
  sink('DEBUG', tag, msg, fields)
}
export function warn(tag: string, msg: string, fields?: Record<string, unknown>): void {
  sink('WARN', tag, msg, fields)
}
export function error(tag: string, msg: string, fields?: Record<string, unknown>): void {
  sink('ERROR', tag, msg, fields)
}
export function trace(tag: string, msg: string, fields?: Record<string, unknown>): void {
  sink('TRACE', tag, msg, fields)
}

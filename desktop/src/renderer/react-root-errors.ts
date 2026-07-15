/**
 * react-root-errors — createRoot error hooks shared by BOTH renderer entries
 * (overlay `main.tsx`, ATV `atv/main.tsx`).
 *
 * Why this exists: React #185 ("maximum update depth exceeded") is thrown by
 * the SCHEDULER, outside the commit an error boundary can catch — so the
 * packaged build logged only the unattributed console line "Minified React
 * error #185" with no component stack, making the looping component
 * unidentifiable. React 19's root options receive the componentStack for
 * exactly these escapes. Every hook logs to desktop.jsonl through the
 * renderer logger, so a packaged-build repro identifies the component
 * without DevTools.
 */
import { rDebug, rError, rWarn } from './rendererLogger'

interface RootErrorInfo {
  componentStack?: string
}

function stack(info: RootErrorInfo): string {
  // One line per frame is noise in JSONL; collapse to a compact arrow chain.
  return (info.componentStack ?? '')
    .split('\n')
    .map((l) => l.trim().replace(/^at /, ''))
    .filter(Boolean)
    .join(' < ')
}

/** Options for `createRoot(container, rootErrorOptions('overlay'|'atv'))`. */
export function rootErrorOptions(surface: string): {
  onUncaughtError: (error: unknown, errorInfo: RootErrorInfo) => void
  onCaughtError: (error: unknown, errorInfo: RootErrorInfo) => void
  onRecoverableError: (error: unknown, errorInfo: RootErrorInfo) => void
} {
  return {
    onUncaughtError: (error, errorInfo) => {
      rError('react-root', 'uncaught react error', {
        surface,
        error: String((error as Error)?.message ?? error),
        component_stack: stack(errorInfo),
      })
    },
    onCaughtError: (error, errorInfo) => {
      // A boundary handled it; still log the stack for correlation.
      rWarn('react-root', 'boundary-caught react error', {
        surface,
        error: String((error as Error)?.message ?? error),
        component_stack: stack(errorInfo),
      })
    },
    onRecoverableError: (error, errorInfo) => {
      rDebug('react-root', 'recoverable react error', {
        surface,
        error: String((error as Error)?.message ?? error),
        component_stack: stack(errorInfo),
      })
    },
  }
}

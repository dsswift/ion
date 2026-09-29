/**
 * Re-export of `@ion/shared/atomic-write`. The implementation moved there
 * because the shared log-shipping stack writes its tailer cursors with it and
 * runs in two processes; every existing `utils/atomicWrite` call site in this
 * package is unchanged.
 */
export * from '@ion/shared/atomic-write'

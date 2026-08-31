/**
 * System-surface IPC channel names.
 *
 * Extracted from `types-ipc.ts`, which sits within a handful of lines of the
 * 600-line cap. Adding a channel there directly would breach it, and the rule
 * is to extract at a real seam rather than shave comments off a registry whose
 * comments are what make the channels legible.
 *
 * The seam is "machine-and-OS facilities": font enumeration, diagnostics, and
 * the native clipboard. None of them belong to a feature domain — they are
 * services any surface may reach for — which is why they cluster cleanly.
 *
 * Spread into `IPC` by types-ipc.ts, so every existing `IPC.LIST_FONTS`
 * reference keeps working unchanged.
 */
export const SYSTEM_IPC = {
  LIST_FONTS: 'ion:list-fonts',
  GET_DIAGNOSTICS: 'ion:get-diagnostics',
  /**
   * Copy PNG bytes to the OS clipboard.
   *
   * Generic on purpose: the renderer supplies bytes and main validates them.
   * Chart Output is the first caller, but nothing about the channel is
   * chart-specific, so the next surface that needs a real clipboard image does
   * not add a second handler with its own validation rules.
   */
  COPY_PNG_TO_CLIPBOARD: 'ion:copy-png-to-clipboard',
  /**
   * Main → renderer: scroll the active conversation to a chart's newest card.
   *
   * A push rather than a return value because the requester (the attachments
   * panel) and the target (the transcript) are different components that may
   * live in different windows under the Studio mirror.
   */
  CHART_JUMP: 'ion:chart-jump',
  /**
   * Renderer → main: rebuild a conversation's chart index from its ACTIVE
   * BRANCH after the branch changed (a rewind, or a fork adopting its own
   * durable conversation).
   *
   * The renderer is the authority for which rows a branch can see, and main is
   * the authority for the durable index — so the rows travel and the rebuild
   * stays where the files are. Sent rather than invoked: the caller's history
   * flow must not wait on disk I/O, and every failure is logged by main.
   */
  CHART_RECONCILE: 'ion:chart-reconcile',
} as const

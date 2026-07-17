/**
 * Conversation tail fingerprint — the cross-platform staleness signal for the
 * iOS main-conversation heal.
 *
 * The iOS client builds its main conversation from live wire deltas
 * (desktop_text_delta / desktop_tool_start / desktop_tool_end) plus a one-time
 * history load. When deltas are lost (e.g. a LAN↔relay transport switch or a
 * seq gap mid-stream), iOS silently freezes — a tool stays "running", the
 * assistant text stops mid-sentence — while the desktop streams to completion.
 *
 * This fingerprint lets iOS DETECT that drift cheaply. The desktop computes it
 * over the active conversation's message tail and sends it in the snapshot;
 * iOS computes the SAME fingerprint over its local tail and compares. When in
 * sync (even mid-stream) the two are byte-identical, so there is no
 * false-positive reload; when iOS missed a delta they diverge and iOS re-fetches
 * the authoritative history.
 *
 * CRITICAL: the Swift implementation (conversationTailFingerprint in
 * SessionViewModel+Snapshot.swift) MUST produce byte-identical output for the
 * same input. The pinning rules:
 *
 *   - Rows: PERSISTED roles only (user / assistant / tool), filtered before
 *     the window. Client-local rows (thinking synthesis, live-inserted system
 *     dividers, harness notices) carry ids only one side knows and would
 *     diverge the fingerprints permanently.
 *   - Window: the last TAIL_WINDOW remaining messages, in order.
 *   - Per message token:
 *       tool rows:        "<toolId>:t<statusToken>"   (status only — see below)
 *       non-tool rows:    "<id>:<utf8ByteLen>"
 *     statusToken ∈ { r, c, e, - } for running / completed / error / none.
 *     Tool rows key on the engine toolId (row id as fallback); text rows on
 *     the canonical engine row id (history rows carry it; live rows re-key at
 *     message_end). Heals are suppressed while streaming, so provisional
 *     mid-run ids never reach a comparison.
 *   - Tokens joined with ",". No total-message-count suffix.
 *   - Content length is UTF-8 BYTE length (Swift `content.utf8.count`,
 *     JS `new TextEncoder().encode(content).length`) — never UTF-16 .length,
 *     which would diverge on any non-ASCII content and cause a reload loop.
 *   - Tool rows are fingerprinted by STATUS ONLY (no content length). The
 *     history page truncates tool content >2KB (tabs.ts) while the snapshot
 *     sees the full content, so including a tool's content length would make
 *     a big tool result permanently diverge after a reload (reload loop). The
 *     tool's status flip (running→completed) is the signal we need, and it is
 *     truncation-immune.
 *
 * Any change here must be mirrored in the Swift copy
 * (SessionViewModel+Snapshot.swift), and the parity is pinned by tests:
 * desktop conversation-fingerprint.test.ts / compute-conv-fingerprint.test.ts
 * and iOS ConversationStalenessReconcileTests.
 */

/** Number of trailing messages the fingerprint spans. Smaller than the history
 *  PAGE_SIZE so pagination never causes divergence: both sides fingerprint the
 *  same final-N window regardless of how much older history each holds. Large
 *  enough to span a stuck tool plus its surrounding turn. */
export const FINGERPRINT_TAIL_WINDOW = 10

/**
 * Roles that participate in the fingerprint. Only PERSISTED roles — the rows
 * both sides can hold with identical canonical ids (history rows carry
 * SessionLoadMessage.id; live rows re-key at message_end; tool rows key on
 * toolId). Client-local rows — thinking synthesis, system dividers inserted
 * live with local ids, harness/intercept notices — exist on one side with an
 * id the other side can never share, so including them makes the two
 * fingerprints permanently diverge and the heal loop forever.
 */
const FINGERPRINT_ROLES = new Set(['user', 'assistant', 'tool'])

/** Minimal message shape the fingerprint needs. */
export interface FingerprintMessage {
  id: string
  role: string
  content: string
  toolStatus?: string
  /** Engine tool id on tool rows — the cross-platform row key. */
  toolId?: string
}

/** UTF-8 byte length, matching Swift's `content.utf8.count`. */
function utf8ByteLength(s: string): number {
  return new TextEncoder().encode(s).length
}

/** Map a tool status to its single-char token. */
function statusToken(toolStatus: string | undefined): string {
  switch (toolStatus) {
    case 'running': return 'r'
    case 'completed': return 'c'
    case 'error': return 'e'
    default: return '-'
  }
}

/**
 * Build the tail fingerprint for a conversation's message list.
 *
 * The fingerprint is the joined tail tokens ONLY — it deliberately does NOT
 * include a total message count. iOS holds a paginated PAGE of the conversation
 * (its local count is the page size), while the desktop holds the FULL list, so
 * any total-count term would diverge on every conversation longer than one page
 * and reload-loop the iOS heal. The tail tokens alone are complete: a message
 * can only enter the conversation by being appended at the end (deltas append),
 * so a dropped new message shifts a tail token; a message only falls outside the
 * tail after 10+ newer messages arrive, which themselves shift tail tokens. The
 * tail is both pagination-safe and sufficient.
 */
export function conversationTailFingerprint(messages: FingerprintMessage[]): string {
  // Persisted roles only (see FINGERPRINT_ROLES) — filter BEFORE windowing so
  // both sides window over the same row population regardless of how many
  // client-local rows each interleaves.
  const persisted = messages.filter((m) => FINGERPRINT_ROLES.has(m.role))
  const tail = persisted.slice(Math.max(0, persisted.length - FINGERPRINT_TAIL_WINDOW))
  const tokens = tail.map((m) => {
    if (m.role === 'tool') {
      // Keyed by the engine tool id — identical on a live-streamed tool row
      // and its history-reloaded counterpart. Row id is only the fallback
      // for a tool row that somehow lacks one.
      return `${m.toolId || m.id}:t${statusToken(m.toolStatus)}`
    }
    return `${m.id}:${utf8ByteLength(m.content || '')}`
  })
  return tokens.join(',')
}

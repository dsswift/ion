/**
 * Injection-suppression policy — ONE opinion, read by every surface.
 *
 * ── Why this file exists ────────────────────────────────────────────────────
 *
 * The engine classifies an injected turn and publishes two facts: a `kind`
 * string and the `machineAuthored` boolean derived from it. It has no opinion
 * about what a client does with them (ADR-017). Suppressing machine-to-machine
 * turns from the transcript is the DESKTOP's opinion, and this module is the
 * single place that opinion is expressed.
 *
 * It replaces a set of hand-copied string lists — one in the live event
 * reducer, one in the history mapper, plus their iOS twins — that every new
 * kind required editing by hand. Nothing failed when one was missed, and they
 * had already drifted: the history mapper filtered two kinds while the live
 * reducer filtered three, so a `slash_command` injection was hidden while
 * streaming and then APPEARED when history rehydrated, silently changing the
 * shape of the transcript under the user.
 *
 * Reading `machineAuthored` instead of matching kinds means a kind added to
 * the engine is suppressed correctly here with no change to this file at all.
 */

/**
 * The minimum shape needed to classify a turn. Both the live event
 * (`engine_prompt_injected`) and a persisted history row satisfy it, which is
 * what lets one function serve both and makes divergence impossible.
 */
export interface InjectionClassification {
  /** Engine-derived: an engine-side actor authored this turn, not a user. */
  machineAuthored?: boolean
  /** The semantic kind. Present on both live events and persisted rows. */
  injectionKind?: string
}

/**
 * Kinds that predate the `machineAuthored` flag.
 *
 * This is a MIGRATION fallback, not a second policy. Conversation files
 * already on disk carry `injectionKind` with no `machineAuthored`, so a row
 * reloaded from one of them would classify as user-authored and the
 * suppressed turn would reappear in the scrollback. The engine re-derives the
 * flag when flattening entries, so this covers only rows that reach a client
 * without passing through that path.
 *
 * Do NOT add new kinds here. A kind added to the engine arrives with
 * `machineAuthored` already set; extending this list would recreate the
 * hand-maintained list this module exists to remove.
 */
const LEGACY_MACHINE_KINDS: ReadonlySet<string> = new Set([
  'agent_completion',
  'slash_command',
  'background_task_completion',
])

/**
 * Whether this injected turn is hidden from the transcript.
 *
 * True for a machine-to-machine turn: a dispatch callback, a background task
 * result, a scheduled check-in, or the expanded body of a slash command whose
 * display turn is persisted separately. The model sees all of them in its
 * context; the user did not write any of them, and rendering them puts raw
 * command output and internal signalling on screen as user messages.
 *
 * The engine's flag is authoritative when present. The kind is consulted only
 * for rows that predate it.
 */
export function suppressesInjection(m: InjectionClassification): boolean {
  if (m.machineAuthored) return true
  if (OUTBOUND_MACHINE_KINDS.has(m.injectionKind ?? '')) return true
  return LEGACY_MACHINE_KINDS.has(m.injectionKind ?? '')
}

/**
 * Kinds the DESKTOP ITSELF authors on an outbound prompt AND hides.
 *
 * Distinct from LEGACY_MACHINE_KINDS above, and the distinction is the
 * direction of travel. LEGACY covers INBOUND rows read back from disk that
 * predate the engine's `machineAuthored` flag. This set covers OUTBOUND turns
 * the desktop is about to send, where the flag cannot exist yet: the desktop
 * is the author, the engine derives `machineAuthored` only once the prompt
 * reaches it, and the renderer must decide whether to insert a bubble BEFORE
 * that round-trip.
 *
 * Currently EMPTY, and that is a decision rather than an oversight.
 * `structured_answer` lived here until it was reclassified: a Guided
 * Questions submission is real operator input — a person read the questions,
 * chose the options, typed the text, attached the images — so it renders in
 * the transcript with a "Questions answered" label instead of being hidden.
 * Hiding it dropped work the operator actually did.
 *
 * A kind belongs here only when the desktop sends it AND the engine
 * classifies it machine-authored. If neither side hides it, it does not
 * belong here.
 */
const OUTBOUND_MACHINE_KINDS: ReadonlySet<string> = new Set<string>()

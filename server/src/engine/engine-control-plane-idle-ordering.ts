/**
 * Ordering decision for an idle `engine_status` snapshot.
 *
 * THE DEFECT THIS PREVENTS
 *
 * The control plane synthesizes a `task_complete` whenever the engine reports
 * `state: 'idle'`. That is correct for the idle that ENDS a run, and wrong for
 * an idle that describes the session BEFORE the operator's prompt reached it.
 *
 * Both idles exist, milliseconds apart, on the ordinary send path:
 *
 *   1. submitPrompt sets tab.activeRequestId and status 'connecting'.
 *   2. ensureSession starts the engine session, and start_session fires a
 *      `reconcile_state` handshake asking the engine to re-emit its state.
 *   3. ensureSession succeeds, so the plane sets status 'running'.
 *   4. The reconcile answer arrives. SendPrompt has not run yet, so the engine
 *      honestly reports idle — it has no run.
 *   5. The handler reads that idle as a completion, synthesizes task_complete,
 *      and the conversation is marked done. Seconds later the real run starts.
 *
 * Observed live on conversation 1783703005832-8f9ea7705fa6: a false
 * `task_complete` 6 ms after the prompt, the real one 39 s later.
 *
 * The pre-existing guard skips a stale idle while `tab.status === 'connecting'`.
 * It does not fire here because step 3 already moved the tab to 'running'.
 *
 * TWO SIGNALS, USED IN ORDER
 *
 * `runEpoch` (engine-supplied) is exact. The engine increments it under the
 * same lock hold that assigns run identity, so a snapshot built before the
 * dispatch carries a strictly lower value than every snapshot built after it.
 * Comparing it against the epoch observed at send time answers the ordering
 * question by arithmetic. It requires an engine new enough to send the field.
 *
 * `activeRequestId` (desktop-supplied) is the fallback for an engine that does
 * not. The desktop sets it before it asks for a session and clears it when a
 * run terminates, so a set value means "this client dispatched a prompt whose
 * run the engine has not yet confirmed". Weaker, because it infers ordering
 * from local bookkeeping rather than reading it off the snapshot — but it
 * closes the defect on the currently-installed binary.
 *
 * A run identifier is deliberately NOT the mechanism. The engine mints its run
 * ID internally as "<key>-<millis>" while the desktop mints its own request ID
 * before calling the engine; the two are independent and never comparable, so
 * there is nothing to match. The question is ordering, not identity.
 */

/** What the decision reads from the control-plane tab entry. */
export interface IdleOrderingTab {
  /** Set by submitPrompt before the session start; cleared at run exit. */
  activeRequestId: string | null
  /** Epoch observed when this tab last dispatched, or null if never. */
  dispatchRunEpoch: number | null
  /**
   * True once the engine has ACKNOWLEDGED the prompt now in flight — the
   * `send_prompt` RPC returned. Cleared at dispatch, set when the send
   * resolves.
   *
   * Load-bearing for the fallback, and the acknowledgement is the right
   * boundary rather than a proxy for one. The engine's dispatch arm calls
   * `SendPrompt` and only then replies (`internal/server/dispatch.go`), and
   * `SendPrompt` assigns run identity before it returns
   * (`internal/session/prompt_dispatch.go`). So an idle snapshot that arrives
   * before the acknowledgement was necessarily built before the engine had a
   * run — which is precisely the defect window — and one that arrives after it
   * describes a session that has the run.
   *
   * `activeRequestId` alone cannot serve: it stays set for the WHOLE run, so
   * refusing on it would also refuse the run-ending idle and leave the
   * conversation stuck in Working — a worse bug than the one being fixed.
   *
   * A `state: 'running'` emission is NOT used as this signal. It is not
   * guaranteed to precede the terminal idle for every run (a run that produces
   * no streaming work can go straight to idle), so keying on it would wedge
   * those conversations.
   */
  dispatchAcknowledged: boolean
}

export type IdleOrderingVerdict =
  | { stale: false; reason: 'epoch_advanced' | 'no_prompt_in_flight' | 'session_rebased' | 'dispatch_acknowledged' }
  | { stale: true; reason: 'epoch_not_advanced' | 'dispatch_unacknowledged' }

/**
 * Decide whether an idle snapshot describes the state BEFORE this tab's
 * in-flight prompt, and therefore must not be read as its completion.
 *
 * @param tab            the control-plane entry for the tab
 * @param snapshotEpoch  StatusFields.runEpoch from the arriving snapshot;
 *                       undefined when the engine predates the field
 */
export function idleOrdering(
  tab: IdleOrderingTab,
  snapshotEpoch: number | undefined,
): IdleOrderingVerdict {
  // No prompt in flight: nothing can be out of order. Every idle in this state
  // is either a genuine run exit or a heartbeat, both of which the existing
  // duplicate-skip guards already handle.
  if (tab.activeRequestId == null) {
    return { stale: false, reason: 'no_prompt_in_flight' }
  }

  // Exact path: the engine told us where this snapshot sits relative to the
  // dispatch. A snapshot at or below the epoch we recorded when we sent was
  // built before the engine accepted the prompt.
  if (snapshotEpoch != null && tab.dispatchRunEpoch != null) {
    // A DECREASE means the session was recreated (engine restart, or a resume
    // after StopSession) and its counter began again at zero. The snapshot is
    // from a new session, not a stale one; refusing it would discard every
    // status the new session emits. Accept and let the caller rebase.
    if (snapshotEpoch < tab.dispatchRunEpoch) {
      return { stale: false, reason: 'session_rebased' }
    }
    if (snapshotEpoch === tab.dispatchRunEpoch) {
      return { stale: true, reason: 'epoch_not_advanced' }
    }
    return { stale: false, reason: 'epoch_advanced' }
  }

  // Fallback path: no epoch on the wire. The refusal is narrowed to the window
  // the defect lives in — prompt dispatched, engine has not yet acknowledged
  // it. Once the send RPC returns, the engine has run identity, so a later idle
  // IS a run boundary and must be accepted.
  if (tab.dispatchAcknowledged) {
    return { stale: false, reason: 'dispatch_acknowledged' }
  }
  return { stale: true, reason: 'dispatch_unacknowledged' }
}

/** The ordering markers a dispatch establishes, and where they came from. */
export interface DispatchOrderingBaseline {
  dispatchRunEpoch: number | null
  dispatchAcknowledged: false
}

/**
 * The ordering baseline a prompt dispatch establishes: the engine's run
 * counter as last observed, and a cleared acknowledgement.
 *
 * Lives beside `idleOrdering` rather than inline in submitPrompt because the
 * two halves are one contract — a baseline recorded under different rules than
 * the comparison reads it is the defect, not a refactor. Keeping them adjacent
 * is what makes a divergence visible.
 */
export function dispatchOrderingBaseline(lastObservedRunEpoch: number | null): DispatchOrderingBaseline {
  return { dispatchRunEpoch: lastObservedRunEpoch, dispatchAcknowledged: false }
}

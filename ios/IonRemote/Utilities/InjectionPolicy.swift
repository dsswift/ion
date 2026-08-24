import Foundation

/// Injection-suppression policy — ONE opinion, read by every surface.
///
/// ── Why this type exists ────────────────────────────────────────────────────
///
/// The engine classifies an injected turn and publishes two facts: a `kind`
/// string and the `machineAuthored` boolean derived from it. It has no opinion
/// about what a client does with them (ADR-017). Suppressing machine-to-machine
/// turns from the transcript is this CLIENT's opinion, and this type is the
/// single place it is expressed.
///
/// It replaces the hand-copied kind lists that used to live in
/// `SessionViewModel+EventHandlers` (live events) and
/// `SessionViewModel+PermissionMessageEvents` (history) — two lists that had
/// already drifted, one filtering three kinds and the other two. Reading
/// `machineAuthored` instead of matching kinds means a kind added to the engine
/// is suppressed correctly here with no change to this file at all.
///
/// The desktop twin is `desktop/src/shared/injection-policy.ts`. The two are
/// pinned to identical verdicts by `InjectionPolicyTests`.
enum InjectionPolicy {

    /// Kinds that predate the `machineAuthored` flag.
    ///
    /// This is a MIGRATION fallback, not a second policy. Conversation files
    /// already on disk carry `injectionKind` with no `machineAuthored`, so a
    /// row reloaded from one of them would classify as user-authored and the
    /// suppressed turn would reappear in the scrollback.
    ///
    /// Do NOT add new kinds here. A kind added to the engine arrives with
    /// `machineAuthored` already set; extending this list would recreate the
    /// hand-maintained list this type exists to remove.
    static let legacyMachineKinds: Set<String> = [
        "agent_completion",
        "slash_command",
        "background_task_completion",
    ]

    /// Kinds a CLIENT authors on an outbound prompt AND hides.
    ///
    /// Distinct from `legacyMachineKinds` above, and the distinction is the
    /// direction of travel. Legacy covers INBOUND rows read back from disk
    /// that predate the engine's `machineAuthored` flag. This set covers
    /// OUTBOUND turns a client authors, where the flag cannot exist yet.
    ///
    /// Currently EMPTY, and deliberately so. `structured_answer` lived here
    /// until it was reclassified: a Guided Questions submission is real
    /// operator input — a person read the questions, chose the options, typed
    /// the text, attached the images — so it RENDERS with a "Questions
    /// answered" label rather than being hidden. Hiding it dropped work the
    /// operator actually did.
    ///
    /// A kind belongs here only when a client sends it AND the engine
    /// classifies it machine-authored.
    static let outboundMachineKinds: Set<String> = []

    /// Whether an injected turn is hidden from the transcript.
    ///
    /// True for a machine-to-machine turn: a dispatch callback, a background
    /// task result, a scheduled check-in, or the expanded body of a slash
    /// command whose display turn is persisted separately. The model sees all
    /// of them in its context; the user authored none of them, and rendering
    /// them puts raw command output and internal signalling on screen as user
    /// messages.
    ///
    /// The engine's flag is authoritative when present. The kind is consulted
    /// only for rows that predate it.
    static func suppresses(machineAuthored: Bool?, injectionKind: String?) -> Bool {
        if machineAuthored == true { return true }
        let kind = injectionKind ?? ""
        if outboundMachineKinds.contains(kind) { return true }
        return legacyMachineKinds.contains(kind)
    }

    /// Convenience overload for a decoded history row.
    static func suppresses(_ message: Message) -> Bool {
        suppresses(machineAuthored: message.machineAuthored, injectionKind: message.injectionKind)
    }
}

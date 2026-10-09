import Foundation

// MARK: - Render spans
//
// The spans that end when something is on screen: `snapshot.apply` around the
// snapshot handler, `transcript.apply` around one patch, and the moment a
// patch is the first visible update of an answer, which ends the tab's
// `prompt.visible` (`ClientSpanBook`). See docs/observability/log-schema.md
// § "Where each span starts and ends".

extension SessionViewModel {

    static let snapshotApplySpanName = "snapshot.apply"
    static let transcriptApplySpanName = "transcript.apply"

    /// A snapshot was decoded and is about to be applied. The launch's first
    /// snapshot is a child of `app.launch`; a resync's is its own trace.
    @MainActor
    func beginSnapshotApplySpan(tabCount: Int) -> TraceSpan {
        TraceSpan(
            name: Self.snapshotApplySpanName,
            parent: AppLaunchTrace.shared.parentForFirst(Self.snapshotApplySpanName),
            attributes: ["surface": "ios", "tabs": String(tabCount)]
        )
    }

    /// A transcript patch was decoded and is about to be applied. It parents
    /// under the tab's open `prompt.visible` when one waits (the patch is the
    /// answer rendering), else under the run's own span when the frame named
    /// one, else it is a root.
    @MainActor
    func beginTranscriptApplySpan(_ patch: TranscriptPatch) -> TraceSpan {
        let waiting = ClientSpanBook.shared.promptVisibleParent(tabId: patch.tabId, traceId: patch.traceId)
        let frame = patch.traceId.flatMap { traceId in patch.spanId.map { TraceContext.format(traceId: traceId, spanId: $0) } }
        return TraceSpan(
            name: Self.transcriptApplySpanName,
            parent: waiting ?? frame,
            traceId: patch.traceId,
            attributes: ["surface": "ios", "tab_id": patch.tabId, "kind": patch.change.kindName, "rev": String(patch.rev)],
            conversationId: tab(for: patch.tabId)?.conversationId
        )
    }

    /// The patch was applied (or not). Ends its span, and when it put the
    /// first of an answer's rows or text on screen, ends the prompt that waited.
    @MainActor
    func endTranscriptApplySpan(_ span: TraceSpan, patch: TranscriptPatch, outcome: TranscriptStream.Outcome) {
        let outcomeLabel: String
        switch outcome {
        case .applied: outcomeLabel = "applied"
        case .ignored(let why): outcomeLabel = "ignored:\(why)"
        case .resync(let why): outcomeLabel = "resync:\(why)"
        }
        span.end(attributes: ["outcome": outcomeLabel])
        guard case .applied = outcome, isAnswerUpdate(patch) else { return }
        ClientSpanBook.shared.promptBecameVisible(tabId: patch.tabId, traceId: patch.traceId)
    }

    /// Whether the applied change shows part of an answer: a row that is not
    /// the person's own prompt, or text appended to one.
    @MainActor
    func isAnswerUpdate(_ patch: TranscriptPatch) -> Bool {
        switch patch.change {
        case .reset:
            return false
        case .splice(_, _, let rows):
            return rows.contains { $0.role != .user }
        case .append(let index, _, _, _):
            guard let startIndex = transcriptStreams[patch.tabId]?.startIndex else { return false }
            let rows = conversationMessages(patch.tabId)
            let local = index - startIndex
            guard rows.indices.contains(local) else { return false }
            return rows[local].role != .user
        }
    }
}

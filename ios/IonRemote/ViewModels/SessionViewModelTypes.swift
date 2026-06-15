import Foundation

// MARK: - EngineDialogInfo

/// Identifiable dialog descriptor used when the engine asks the client
/// to present a modal (select / confirm / input). Carries the engine's
/// dialogId so the response can be paired with the request, plus the
/// minimum render information (title, options, default value).
///
/// Extracted from SessionViewModel.swift in the
/// cosy-pacing-bee.md branch so the main view-model file stays under
/// the 600-line cap after the /export work added PendingExport.
struct EngineDialogInfo: Identifiable {
    let id: String
    let method: String
    let title: String
    let options: [String]?
    let defaultValue: String?

    init(dialogId: String, method: String, title: String, options: [String]?, defaultValue: String?) {
        self.id = dialogId
        self.method = method
        self.title = title
        self.options = options
        self.defaultValue = defaultValue
    }
}

// MARK: - PendingExport

/// A /export payload waiting to be presented via the iOS share sheet.
///
/// Carries the rendered output verbatim from the engine plus the tabId
/// so view layer can scope a per-tab share sheet observation. The
/// `id` is a fresh UUID so a `.sheet(item:)` binding on a SwiftUI view
/// re-fires whenever a new export arrives (the `id` change forces
/// re-presentation), matching the same pattern EngineDialogInfo uses
/// for one-shot dialog presentation.
struct PendingExport: Identifiable, Sendable {
    let id: UUID
    let tabId: String
    let payload: String
    /// Engine-resolved export format ("markdown" | "json" | "html" |
    /// "jsonl"), nil when the engine predates the exportFormat field.
    /// The view layer maps it to a file extension; nil defaults to
    /// markdown.
    let format: String?

    init(tabId: String, payload: String, format: String?) {
        self.id = UUID()
        self.tabId = tabId
        self.payload = payload
        self.format = format
    }
}

// MARK: - EventBatcher

/// Collects remote events off the main thread so they can be drained
/// in a single batch and processed in one MainActor block per frame.
/// Mirrors the desktop's render-layer batching for engine_text_delta
/// floods.
actor EventBatcher {
    private var buffer: [RemoteEvent] = []

    func enqueue(_ event: RemoteEvent) {
        buffer.append(event)
    }

    func drain() -> [RemoteEvent] {
        let batch = buffer
        buffer.removeAll(keepingCapacity: true)
        return batch
    }
}

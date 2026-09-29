import Foundation
@testable import IonRemote

/// Builders for the transcript stream tests: a server page, a patch, and rows.
enum TranscriptTestSupport {

    static let epoch = "epoch-1"

    static func streamId(_ tabId: String) -> String { "tab:\(tabId):main" }

    /// A newest page holding the whole transcript, at `rev`.
    static func page(
        tabId: String,
        rows: [Message],
        rev: Int = 0,
        startIndex: Int = 0,
        total: Int? = nil,
        epoch: String = epoch,
        isNewest: Bool = true
    ) -> TranscriptPage {
        TranscriptPage(
            tabId: tabId,
            instanceId: "main",
            streamId: streamId(tabId),
            epoch: epoch,
            rev: rev,
            total: total ?? startIndex + rows.count,
            startIndex: startIndex,
            rows: rows,
            hasOlder: startIndex > 0,
            isNewest: isNewest
        )
    }

    static func patch(
        tabId: String,
        baseRev: Int,
        total: Int,
        change: TranscriptChange,
        epoch: String = epoch
    ) -> TranscriptPatch {
        TranscriptPatch(
            streamId: streamId(tabId), tabId: tabId, instanceId: "main", conversationId: nil,
            epoch: epoch, baseRev: baseRev, rev: baseRev + 1, total: total, change: change
        )
    }

    static func row(_ id: String, _ role: MessageRole = .assistant, _ content: String = "") -> Message {
        Message(id: id, role: role, content: content, timestamp: 1_700_000_000_000)
    }

    static func tab(_ id: String, status: TabStatus = .idle) -> RemoteTabState {
        RemoteTabState(
            id: id, title: id, customTitle: nil, status: status, workingDirectory: "/tmp",
            permissionMode: .auto, thinkingEffort: nil, permissionQueue: [], hasEngineExtension: true
        )
    }
}

import SwiftUI
import UIKit

/// Shared clipboard actions for each iOS conversation-list presentation.
struct ConversationClipboardActions: View {
    let tab: RemoteTabState
    @Environment(SessionViewModel.self) private var viewModel

    var body: some View {
        if tab.isTerminalOnly != true {
            Button {
                viewModel.copyTranscript(tabId: tab.id)
            } label: {
                Label("Copy Transcript", systemImage: "doc.on.doc")
            }

            if !resolvedSessionIds.isEmpty {
                Button {
                    UIPasteboard.general.string = resolvedSessionIds.joined(separator: "\n")
                    DiagnosticLog.log("session ids copied", tag: "conversation.clipboard", fields: [
                        "tab_id": tab.id,
                        "count": String(resolvedSessionIds.count),
                    ])
                    viewModel.showToast(ToastMessage(style: .success, title: "Session ID copied"))
                } label: {
                    Label("Copy Session ID", systemImage: "doc.on.doc")
                }
            }
        }
    }

    /// Prefer the desktop's canonical full chain. The local merge keeps copy
    /// useful with older desktops that do not project `sessionIds` yet.
    var resolvedSessionIds: [String] {
        let instanceId = viewModel.activeEngineInstance[tab.id]
        let instance = viewModel.engineInstance(tabId: tab.id, instanceId: instanceId)
        return Self.resolveSessionIds(tab: tab, fallbackInstance: instance)
    }

    static func resolveSessionIds(
        tab: RemoteTabState,
        fallbackInstance: ConversationInstanceInfo?
    ) -> [String] {
        if let canonical = tab.sessionIds, !canonical.isEmpty {
            return orderedUnique(canonical)
        }

        var ids: [String] = []
        if tab.hasEngineExtension == true {
            ids.append(contentsOf: fallbackInstance?.conversationIds ?? [])
            if let current = fallbackInstance?.statusFields?.sessionId { ids.append(current) }
        } else if let conversationId = tab.conversationId {
            ids.append(conversationId)
        }
        return orderedUnique(ids)
    }

    private static func orderedUnique(_ values: [String]) -> [String] {
        var seen: Set<String> = []
        return values.filter { !$0.isEmpty && seen.insert($0).inserted }
    }
}

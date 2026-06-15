import SwiftUI

/// Row-dispatch helpers extracted from `ConversationView` to keep the
/// main view file under the 600-line cap. These two private methods
/// switch on `RowItem` and `ConversationItem` respectively and return
/// the SwiftUI view for each variant.
///
/// Co-located here (not nested or renamed) so the call sites in
/// `ConversationView.body` read identically — the extraction is
/// mechanical motion, not a refactor. The methods stay private to the
/// extension so they remain in the same access scope as the view's
/// other helpers.
extension ConversationView {

    // MARK: - Row dispatch

    @ViewBuilder
    func rowView(_ rowItem: RowItem) -> some View {
        switch rowItem {
        case .loadMore:
            Button {
                viewModel.loadMoreMessages(tabId: tabId)
            } label: {
                if isLoading {
                    ProgressView()
                } else {
                    Text("Load earlier messages")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
            .padding(.vertical, 8)

        case .loading:
            ProgressView("Loading conversation...")
                .padding(.top, 40)

        case .loadFailed:
            Button {
                viewModel.loadConversation(tabId: tabId)
            } label: {
                VStack(spacing: 8) {
                    Image(systemName: "arrow.clockwise")
                        .font(.title2)
                    Text("Couldn't load conversation.\nTap to retry.")
                        .font(.subheadline)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                }
            }
            .buttonStyle(.plain)
            .padding(.top, 40)

        case .empty:
            VStack(spacing: 12) {
                Image("IonIcon")
                    .resizable()
                    .scaledToFit()
                    .frame(width: 48, height: 48)
                    .foregroundStyle(.tertiary)
                Text("Send a message to get started")
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
            }
            .frame(maxWidth: .infinity)
            .padding(.top, 80)

        case .conversation(let item):
            conversationItemView(item)

        case .liveText(let text):
            Text(text)
                .font(.system(.body, design: .monospaced))
                .textSelection(.enabled)
                .padding(.horizontal)
        }
    }

    // MARK: - Conversation item dispatch

    @ViewBuilder
    func conversationItemView(_ item: ConversationItem) -> some View {
        switch item {
        case .user(let message):
            EngineMessageRow(
                message: message,
                onRewind: { messageId in
                    viewModel.rewindConversation(tabId: tabId, messageId: messageId)
                },
                onFork: { messageId in
                    viewModel.forkFromMessage(tabId: tabId, messageId: messageId)
                }
            )

        case .assistant(let message):
            let isLast = message.id == conversationMessages.last?.id
            let combined = consecutiveAssistantContent(
                for: message.id, in: conversationMessages
            )
            let voiceSvc = viewModel.voiceService
            EngineMessageRow(
                message: message,
                copyableContent: combined,
                isSpeaking: voiceSvc.speakingMessageId == message.id && voiceSvc.isSpeaking,
                isRunning: isRunning && isLast,
                onSkipSpeaking: { voiceSvc.skip() },
                onStopAllSpeaking: { voiceSvc.stop() },
                hasPendingSpeech: voiceSvc.hasPending
            )

        case .system(let message):
            EngineMessageRow(message: message, copyableContent: message.content)

        case .toolGroup(let tools):
            EngineToolGroupRow(tools: tools)

        case .compaction(let message):
            CompactionRowView(message: message)

        case .agentTurn(let tools, let assistantMessages, let isActive):
            AgentTurnRow(tools: tools, assistantMessages: assistantMessages, isActive: isActive)
        }
    }
}

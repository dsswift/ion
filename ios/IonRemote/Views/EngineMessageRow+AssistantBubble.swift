import SwiftUI

// MARK: - Assistant bubble rendering
//
// Extracted from `EngineMessageRow.swift` to keep that file under the 600-line
// cap and to make room for the conversation-surface rebuild (assistant-as-
// document, streaming cursor, voice controls, copy overlay). This extension
// owns all assistant-role rendering: the conversation-view unbubbled document
// and the engine-view compact markdown row. Both read from `EngineMessageRow`'s
// stored properties directly, so the extraction is purely organizational — no
// API or call-site changes. Mirrors the ToolBubble / UserBubble / SlashBubble
// splits already in this folder.

extension EngineMessageRow {

    // MARK: - Assistant

    var assistantMessage: some View {
        Group {
            if isConversationMode {
                conversationAssistantBubble
            } else {
                engineAssistantBubble
            }
        }
    }

    /// Full conversation-view assistant message is a document, not a bubble.
    /// Copy remains available from the long-press menu. The trailing glyph is
    /// persistent so it never appears then disappears while someone is reading.
    private var conversationAssistantBubble: some View {
        VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
            HStack(alignment: .bottom, spacing: IonSpace.hairlineGap) {
                VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                    if !message.content.isEmpty {
                        MarkdownContentView(
                            blocks: MarkdownBlockCache.shared.blocks(for: message.content),
                            onOpenFile: onOpenFile
                        )
                        .textSelection(.enabled)
                    }
                    if !message.imageAttachments.isEmpty {
                        MessageAttachmentImages(attachments: message.imageAttachments, alignment: .leading, onPreview: previewAttachment)
                    }
                }
                Spacer(minLength: 0)
                Image(systemName: "doc.on.doc")
                    .font(IonType.metadata)
                    .foregroundStyle(theme.textTertiary)
                    .accessibilityLabel("Copy")
            }
            Text(relativeTimestamp)
                .font(IonType.metadata)
                .foregroundStyle(theme.textTertiary)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.horizontal, IonSpace.rowInset)
        .padding(.vertical, IonSpace.hairlineGap)
        .contextMenu {
            Button { UIPasteboard.general.string = copyableContent ?? message.content } label: {
                Label("Copy", systemImage: "doc.on.doc")
            }
            ShareLink(item: copyableContent ?? message.content) {
                Label("Share", systemImage: "square.and.arrow.up")
            }
        } preview: {
            Text(message.content.prefix(200) + (message.content.count > 200 ? "…" : ""))
                .font(IonType.body)
                .padding(IonSpace.contentGap)
                .frame(maxWidth: 300, alignment: .leading)
        }
    }

    /// Engine-view compact assistant bubble: plain markdown, no chrome.
    private var engineAssistantBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                MarkdownContentView(
                    blocks: MarkdownBlockCache.shared.blocks(for: message.content),
                    onOpenFile: onOpenFile
                )
                .textSelection(.enabled)
                .frame(maxWidth: .infinity, alignment: .leading)
                .clipped()
                Spacer(minLength: 0)
            }
            // Provider-generated images on the assistant turn (see
            // conversationAssistantBubble) — render inline here too.
            if !message.imageAttachments.isEmpty {
                MessageAttachmentImages(attachments: message.imageAttachments, alignment: .leading, onPreview: previewAttachment)
            }
        }
    }
}

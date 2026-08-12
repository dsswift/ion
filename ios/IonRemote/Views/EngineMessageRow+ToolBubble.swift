import SwiftUI

// MARK: - Tool bubble rendering
//
// Extracted from `EngineMessageRow.swift` to keep that file under the 600-line
// cap. This extension owns all tool-role rendering: the conversation-view
// expandable detail bubble and the engine-view compact name+status row. Both
// views read from `EngineMessageRow`'s `message` property directly, so the
// extraction is purely organizational — no API or call-site changes.

extension EngineMessageRow {

    // MARK: - Entry point

    var toolMessage: some View {
        Group {
            if isConversationMode {
                conversationToolBubble
            } else {
                engineToolBubble
            }
        }
    }

    // MARK: - Shared helpers

    var toolAccentColor: Color {
        switch message.toolStatus {
        case .running:   return .orange
        case .completed: return .green
        case .error:     return .red
        case nil:        return .gray
        }
    }

    // MARK: - Conversation-view tool bubble

    /// Full conversation-view tool bubble: expandable input/output detail,
    /// with any tool-returned images rendered inline beneath it (always
    /// visible, independent of the expand/collapse state — matching the
    /// desktop tool image strip).
    var conversationToolBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            toolBubbleBody
            if !message.imageAttachments.isEmpty {
                MessageAttachmentImages(attachments: message.imageAttachments, alignment: .leading, onPreview: previewAttachment)
                    .padding(.horizontal, IonSpace.contentGap)
            }
        }
    }

    private var toolBubbleBody: some View {
        HStack(spacing: 0) {
            RoundedRectangle(cornerRadius: 1)
                .fill(toolAccentColor)
                .frame(width: 2)

            VStack(alignment: .leading, spacing: 0) {
                Button {
                    withAnimation(IonTheme.snappySpring) {
                        isToolExpanded.toggle()
                    }
                } label: {
                    HStack(spacing: 8) {
                        conversationToolStatusIcon

                        Text(message.toolName ?? "Tool")
                            .font(.subheadline.monospaced())
                            .foregroundStyle(.primary)

                        Spacer()

                        Image(systemName: isToolExpanded ? "chevron.up" : "chevron.down")
                            .font(.caption)
                            .foregroundStyle(.tertiary)
                    }
                    .padding(.horizontal, IonSpace.contentGap)
                    .padding(.vertical, IonSpace.compactInset)
                }
                .buttonStyle(.plain)

                if isToolExpanded {
                    VStack(alignment: .leading, spacing: 4) {
                        if let input = message.toolInput, !input.isEmpty {
                            Text("Input:")
                                .font(.caption.bold())
                                .foregroundStyle(.secondary)
                            Text(input)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(10)
                        }
                        if !message.content.isEmpty {
                            Text(message.toolStatus == .error ? "Error:" : "Result:")
                                .font(.caption.bold())
                                .foregroundStyle(message.toolStatus == .error ? .red : .secondary)
                            Text(message.content)
                                .font(.caption.monospaced())
                                .textSelection(.enabled)
                                .lineLimit(20)
                                .foregroundStyle(message.toolStatus == .error ? .red : .primary)
                        }
                    }
                    .padding(.horizontal, IonSpace.contentGap)
                    .padding(.bottom, IonSpace.compactGap)
                    .transition(.opacity.combined(with: .move(edge: .top)))
                }
            }
        }
        .background(Color(.tertiarySystemFill))
        .clipShape(RoundedRectangle(cornerRadius: IonRadius.container))
        .padding(.horizontal, IonSpace.contentGap)
        .padding(.vertical, 1) // design-geometry: sub-hairline 1pt inset; below the 4pt rhythm floor
    }

    var conversationToolStatusIcon: some View {
        Group {
            switch message.toolStatus {
            case .running:
                ProgressView()
                    .controlSize(.mini)
            case .completed:
                Image(systemName: "checkmark.circle.fill")
                    .foregroundStyle(.green)
                    .font(.subheadline)
            case .error:
                Image(systemName: "xmark.circle.fill")
                    .foregroundStyle(.red)
                    .font(.subheadline)
            case nil:
                Image(systemName: "gearshape")
                    .foregroundStyle(.secondary)
                    .font(.subheadline)
            }
        }
    }

    // MARK: - Engine-view tool bubble

    /// Engine-view compact tool bubble: icon + name only, no expand.
    /// Tool-returned images render inline beneath the name row.
    var engineToolBubble: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(spacing: 6) {
                engineToolStatusIcon
                Text(message.toolName ?? "tool")
                    .font(.caption.weight(.semibold))
                    .foregroundStyle(.secondary)
                Spacer()
            }
            .padding(.horizontal, IonSpace.compactGap)
            .padding(.vertical, IonSpace.hairlineGap)
            .background(theme.surfaceSecondary)
            .clipShape(RoundedRectangle(cornerRadius: IonRadius.control))

            if !message.imageAttachments.isEmpty {
                MessageAttachmentImages(attachments: message.imageAttachments, alignment: .leading, onPreview: previewAttachment)
            }
        }
    }

    @ViewBuilder
    var engineToolStatusIcon: some View {
        switch message.toolStatus {
        case .running:
            ProgressView()
                .scaleEffect(0.6)
        case .completed:
            Image(systemName: "checkmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.green)
        case .error:
            Image(systemName: "xmark.circle.fill")
                .font(.caption2)
                .foregroundStyle(.red)
        case nil:
            Image(systemName: "wrench")
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
    }
}

import SwiftUI

struct PlanApprovalCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest
    @State private var showFullPlan = false
    @State private var implementOnDismiss = false
    @State private var implementAndUnpinOnDismiss = false
    @State private var isExpanded = true

    private var planContent: String? {
        request.toolInput?["planContent"]?.value as? String
    }

    private var planFilePath: String? {
        request.toolInput?["planFilePath"]?.value as? String
    }

    private var isGroupPinned: Bool {
        viewModel.tabs.first(where: { $0.id == tabId })?.groupPinned == true
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            // Header
            HStack(spacing: 6) {
                Button {
                    withAnimation(IonTheme.snappySpring) { isExpanded.toggle() }
                } label: {
                    HStack(spacing: 6) {
                        Text("Plan Ready")
                            .font(.caption.weight(.semibold))
                            .foregroundStyle(.green)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 4)
                            .background(Color.green.opacity(0.15), in: Capsule())
                        Spacer()
                        Image(systemName: isExpanded ? "chevron.down" : "chevron.up")
                            .font(.caption2)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                if planContent != nil {
                    Button { showFullPlan = true } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(8)
                    }
                    .padding(.leading, 8)
                }
            }

            if isExpanded {
                // Plan content
                if let content = planContent, !content.isEmpty {
                    ScrollView {
                        planTextView(content)
                            .frame(maxWidth: .infinity, alignment: .leading)
                    }
                    .frame(maxHeight: 300)
                    .background(Color(.tertiarySystemFill))
                    .clipShape(RoundedRectangle(cornerRadius: 8))
                    .mask(
                        VStack(spacing: 0) {
                            LinearGradient(colors: [.clear, .black], startPoint: .top, endPoint: .bottom)
                                .frame(height: 8)
                            Color.black
                            LinearGradient(colors: [.black, .clear], startPoint: .top, endPoint: .bottom)
                                .frame(height: 8)
                        }
                    )
                    .contextMenu {
                        Button {
                            UIPasteboard.general.string = content
                        } label: {
                            Label("Copy Plan", systemImage: "doc.on.doc")
                        }
                        if let path = planFilePath {
                            Button {
                                UIPasteboard.general.string = path
                            } label: {
                                Label("Copy Plan File Path", systemImage: "folder")
                            }
                        }
                    }
                }

                // Action buttons — split row when pinned, single button otherwise
                if isGroupPinned {
                    GeometryReader { geo in
                        let spacing: CGFloat = 8
                        // Subtract the card's .padding() insets (16pt each side) so
                        // the buttons don't overflow the card boundary.
                        let availableWidth = geo.size.width - 32
                        let smallWidth = (availableWidth - spacing) * 0.38
                        let largeWidth = availableWidth - spacing - smallWidth
                        HStack(spacing: spacing) {
                            Button {
                                Haptic.medium()
                                implementAndUnpin()
                            } label: {
                                Label("Implement and Unpin", systemImage: "pin.slash")
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .frame(width: largeWidth, height: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(.green)

                            Button {
                                Haptic.medium()
                                implement()
                            } label: {
                                Text("Implement")
                                    .font(.subheadline.weight(.semibold))
                                    .lineLimit(1)
                                    .minimumScaleFactor(0.8)
                                    .frame(width: smallWidth, height: 44)
                            }
                            .buttonStyle(.borderedProminent)
                            .tint(Color(.systemGray3))
                        }
                        .frame(width: availableWidth)
                        .frame(maxWidth: .infinity)
                    }
                    .frame(height: 44)
                } else {
                    Button {
                        Haptic.medium()
                        implement()
                    } label: {
                        Text("Implement")
                            .font(.subheadline.weight(.semibold))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 14)
                    }
                    .buttonStyle(.borderedProminent)
                    .tint(.green)
                }
            }
        }
        .padding()
        .cardStyle()
        .fullScreenCover(isPresented: $showFullPlan, onDismiss: {
            if implementAndUnpinOnDismiss {
                implementAndUnpinOnDismiss = false
                implementAndUnpin()
            } else if implementOnDismiss {
                implementOnDismiss = false
                implement()
            }
        }) {
            if let content = planContent {
                PlanFullScreenView(content: content) {
                    implementOnDismiss = true
                    showFullPlan = false
                }
            }
        }
    }

    private func implement() {
        let prompt: String
        if let content = planContent, !content.isEmpty {
            prompt = "Implement the following plan:\n\n\(content)"
        } else {
            prompt = "Implement the plan."
        }
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        viewModel.implementPlan(tabId: tabId, prompt: prompt)
    }

    private func implementAndUnpin() {
        // Unpin first so the desktop's auto-move guard fires when
        // implementPlan switches the tab to auto mode.
        viewModel.toggleTabGroupPin(tabId: tabId)
        implement()
    }

    @ViewBuilder
    private func planTextView(_ content: String) -> some View {
        Text(MarkdownFormatter.format(content))
            .font(.caption)
            .textSelection(.enabled)
            .padding(8)
    }
}

import SwiftUI

struct PlanApprovalCardView: View {
    @Environment(SessionViewModel.self) private var viewModel
    let tabId: String
    let request: PermissionRequest
    @State private var showFullPlan = false
    @State private var implementOnDismiss = false
    @State private var implementAndUnpinOnDismiss = false
    @State private var isExpanded = true

    // MARK: - Plan data (preview path, plan gentle-perching-lemon)
    //
    // The snapshot no longer carries `planContent` (full body). It now carries:
    //   planContentPreview: String   — first 4 KB for instant card render
    //   planSizeBytes: Int           — full file size in bytes
    //   planTruncated: Bool          — true when file > 4 KB
    //
    // iOS renders the preview immediately. On expand (showFullPlan) or
    // "Copy Plan", it fetches the full body via PlanContentStore (paged
    // request_plan_content commands). The legacy `planContent` key is no
    // longer read — do NOT reference it.

    private var planContentPreview: String? {
        request.toolInput?["planContentPreview"]?.value as? String
    }

    private var planSizeBytes: Int {
        (request.toolInput?["planSizeBytes"]?.value as? Int) ?? 0
    }

    private var planTruncated: Bool {
        (request.toolInput?["planTruncated"]?.value as? Bool) ?? false
    }

    private var planFilePath: String? {
        request.toolInput?["planFilePath"]?.value as? String
    }

    /// Content to display in the inline preview. Uses the preview string from
    /// the snapshot. Never reads the old `planContent` key.
    private var displayContent: String? {
        guard let preview = planContentPreview, !preview.isEmpty else { return nil }
        return preview
    }

    /// Full plan body assembled from paged fetches, once complete.
    private var fullPlanContent: String? {
        viewModel.planContentStore.fullContent(for: request.questionId)
    }

    private var tab: RemoteTabState? {
        viewModel.tabs.first(where: { $0.id == tabId })
    }

    private var showUnpinOption: Bool {
        tab?.groupPinned == true && tab?.hasEngineExtension != true
    }

    private var showClearContextOption: Bool {
        guard let settings = viewModel.desktopSettings,
              let val = settings.currentValue(for: "showImplementClearContext"),
              let on = val.value as? Bool else {
            return false
        }
        return on
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
                if displayContent != nil || planSizeBytes > 0 {
                    Button {
                        ensurePlanFetched()
                        showFullPlan = true
                    } label: {
                        Image(systemName: "arrow.up.left.and.arrow.down.right")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                            .padding(8)
                    }
                    .padding(.leading, 8)
                }
            }

            if isExpanded {
                // Plan content — render preview immediately; no blocking on fetch
                if let content = displayContent, !content.isEmpty {
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
                            copyPlanToClipboard()
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
                if showUnpinOption {
                    GeometryReader { geo in
                        let spacing: CGFloat = 8
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

                if showClearContextOption {
                    Button {
                        Haptic.medium()
                        implement(clearContext: true)
                    } label: {
                        Text("Implement, clear context")
                            .font(.footnote.weight(.medium))
                            .frame(maxWidth: .infinity)
                            .padding(.vertical, 10)
                    }
                    .buttonStyle(.bordered)
                    .tint(.secondary)
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
            // Use the full assembled body when available; fall back to preview.
            let content = fullPlanContent ?? planContentPreview ?? ""
            let isFetching = viewModel.planContentStore.isFetching(questionId: request.questionId)
            PlanFullScreenView(content: content, isFetching: isFetching) {
                implementOnDismiss = true
                showFullPlan = false
            }
        }
    }

    // MARK: - Actions

    private func implement(clearContext: Bool = false) {
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        viewModel.sendImplementPlanIntent(tabId: tabId, questionId: request.questionId, clearContext: clearContext)
    }

    private func implementAndUnpin(clearContext: Bool = false) {
        viewModel.toggleTabGroupPin(tabId: tabId)
        implement(clearContext: clearContext)
    }

    /// Initiate the paged fetch of the full plan body if not already fetched.
    /// Called on expand button tap and on "Copy Plan".
    private func ensurePlanFetched() {
        guard let filePath = planFilePath else { return }
        viewModel.startPlanContentFetch(tabId: tabId, questionId: request.questionId, planFilePath: filePath)
    }

    private func copyPlanToClipboard() {
        // Use the full assembled body if already fetched; otherwise use preview
        // and trigger the fetch in the background so copy on next long-press works.
        if let full = fullPlanContent {
            UIPasteboard.general.string = full
        } else {
            UIPasteboard.general.string = planContentPreview ?? ""
            ensurePlanFetched()
        }
    }

    @ViewBuilder
    private func planTextView(_ content: String) -> some View {
        Text(MarkdownFormatter.format(content))
            .font(.caption)
            .textSelection(.enabled)
            .padding(8)
    }
}

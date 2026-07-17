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
    // The snapshot carries a bounded preview for instant card render:
    //   planContentPreview: String   — first 4 KB for instant card render
    //   planSizeBytes: Int           — full file size in bytes
    //   planTruncated: Bool          — true when file > 4 KB
    //
    // iOS renders the preview immediately. On expand (showFullPlan) or
    // "Copy Plan", it fetches the full body via PlanContentStore (paged
    // request_plan_content commands).
    //
    // Fallback to inline `planContent`: two card-source paths deliver the full
    // body inline in `toolInput.planContent` and NEVER carry `planContentPreview`
    // — (1) the desktop snapshot promotes a permission denial whose toolInput was
    // backfilled from conversation history, and its preview enrichment is skipped
    // when the plan file is unreadable on disk; (2) `computeRestoredSpecialCard`
    // synthesizes the card from a persisted ExitPlanMode message, and the preview
    // key is snapshot-only so it is structurally absent. Reading ONLY
    // `planContentPreview` made both produce a blank card. We therefore prefer the
    // preview and fall back to the inline `planContent` the card already carries.
    // (Earlier this comment said "never read planContent" — that was the bug.)

    private var planContentPreview: String? {
        request.toolInput?["planContentPreview"]?.value as? String
    }

    /// Full plan body delivered inline on the card's toolInput by the backfill /
    /// restored-synthesis paths (which never produce `planContentPreview`).
    private var planContentInline: String? {
        request.toolInput?["planContent"]?.value as? String
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

    /// Content to display in the inline preview. Prefers the bounded snapshot
    /// preview; falls back to the inline `planContent` the card carries when the
    /// snapshot did not enrich a preview (restored / synthesized cards, or an
    /// unreadable plan file). Nil only when neither is present.
    private var displayContent: String? {
        // Prefer the snapshot-carried preview or inline body (tested via
        // resolveDisplayContent). Fall back to any partial content already
        // fetched from the desktop so a normal snapshot entry (which carries
        // neither preview nor inline body) shows content as soon as the first
        // paged fetch completes. The store lookup requires the @Environment
        // SessionViewModel and therefore cannot live in the pure static resolver.
        Self.resolveDisplayContent(toolInput: request.toolInput)
            ?? viewModel.planContentStore.currentContent(for: request.questionId)
    }

    /// Pure precedence resolver for the inline card body, extracted so the
    /// `planContentPreview` → inline-`planContent` fallback is unit-testable
    /// without instantiating the SwiftUI view (which needs an @Environment
    /// SessionViewModel). Returns the non-empty preview if present, else the
    /// non-empty inline body, else nil. Pin: a card carrying only `planContent`
    /// (the backfill / restored-synthesis shape) must resolve to that body.
    static func resolveDisplayContent(toolInput: [String: AnyCodable]?) -> String? {
        if let preview = toolInput?["planContentPreview"]?.value as? String, !preview.isEmpty {
            return preview
        }
        if let inline = toolInput?["planContent"]?.value as? String, !inline.isEmpty {
            return inline
        }
        return nil
    }

    /// Full plan body assembled from paged fetches, once complete.
    private var fullPlanContent: String? {
        viewModel.planContentStore.fullContent(for: request.questionId)
    }

    private var tab: RemoteTabState? {
        viewModel.tabs.first(where: { $0.id == tabId })
    }

    private var showUnpinOption: Bool {
        let resolved = Self.resolveShowUnpinOption(
            groupPinned: tab?.groupPinned,
            hasEngineExtension: tab?.hasEngineExtension
        )
        DiagnosticLog.log(
            "PLAN-CARD: showUnpinOption tabId=\(tabId.prefix(8)) "
            + "groupPinned=\(String(describing: tab?.groupPinned)) "
            + "hasEngineExtension=\(String(describing: tab?.hasEngineExtension)) "
            + "showUnpinOption=\(resolved)"
        )
        return resolved
    }

    /// Pure resolver for the "Implement and Unpin" split-row gate, extracted so
    /// the group-pinned → unpin-option mapping is unit-testable without
    /// instantiating the SwiftUI view (which needs an @Environment
    /// SessionViewModel). Mirrors the desktop gate exactly: the unpin option is
    /// revealed whenever the tab is pinned to its group (`groupPinned == true`),
    /// regardless of whether the conversation is extension-hosted.
    ///
    /// Pin: extension-hosted conversations (`hasEngineExtension == true`) are NOT
    /// excluded. The prior `&& hasEngineExtension != true` predicate was an
    /// orphaned pre-unification artifact — PR #256 (commit 2ade1824) unified
    /// plain and extension-hosted conversations but left the predicate behind,
    /// which hid the unpin button on iOS for extension-hosted, group-pinned tabs
    /// while desktop (which checks only `groupPinned`) still showed it.
    static func resolveShowUnpinOption(groupPinned: Bool?, hasEngineExtension: Bool?) -> Bool {
        groupPinned == true
    }

    private var showClearContextOption: Bool {
        Self.resolveShowClearContext(settings: viewModel.desktopSettings)
    }

    /// Pure resolver for the "Implement, clear context" button gate, extracted
    /// so the desktop-setting → button-visibility mapping is unit-testable
    /// without instantiating the SwiftUI view (which needs an @Environment
    /// SessionViewModel). Mirrors the desktop gate: the button is revealed only
    /// when the `showImplementClearContext` desktop setting is `true`. Returns
    /// `false` when settings are absent or the key is missing/non-boolean.
    static func resolveShowClearContext(settings: DesktopSettingsState?) -> Bool {
        guard let settings,
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
                if displayContent != nil || planSizeBytes > 0 || planFilePath != nil {
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
                // Plan content — render immediately when available. For normal
                // snapshot entries (no inline preview), auto-fetch starts on
                // appear and this block shows the loading indicator until the
                // first page arrives, then switches to the scroll view once
                // currentContent is non-nil.
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
                } else if viewModel.planContentStore.isFetching(questionId: request.questionId) {
                    HStack(spacing: 8) {
                        ProgressView()
                            .scaleEffect(0.75)
                        Text("Loading plan…")
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                    .padding(.vertical, 8)
                }

                // Action buttons — split row when pinned, single button otherwise
                if showUnpinOption {
                    // Native HStack (no GeometryReader): both buttons share the row
                    // 50/50 via .frame(maxWidth: .infinity), so the row reports its
                    // true height to the enclosing VStack and the clear-context
                    // button below flows beneath it instead of overlapping. The
                    // prior GeometryReader (38/62 pixel split) did not report a
                    // stable intrinsic height, which caused the overlap.
                    HStack(spacing: 8) {
                        Button {
                            Haptic.medium()
                            implementAndUnpin()
                        } label: {
                            Label("Implement and Unpin", systemImage: "pin.slash")
                                .font(.subheadline.weight(.semibold))
                                .lineLimit(1)
                                .minimumScaleFactor(0.8)
                                .frame(maxWidth: .infinity, minHeight: 44)
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
                                .frame(maxWidth: .infinity, minHeight: 44)
                        }
                        .buttonStyle(.borderedProminent)
                        .tint(Color(.systemGray3))
                    }
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
        .onAppear {
            // Auto-start the paged fetch so normal snapshot entries (which carry
            // planFilePath but no inline preview) render content without the user
            // needing to tap expand first. No-op when planFilePath is absent,
            // already fetching, or already complete.
            ensurePlanFetched()
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
            // Use the full assembled body when available; fall back to the
            // bounded preview, then to the inline body the card carries.
            let content = fullPlanContent
                ?? planContentPreview
                ?? planContentInline
                ?? viewModel.planContentStore.currentContent(for: request.questionId)
                ?? ""
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
        viewModel.dismissSpecialPermission(tabId: tabId, questionId: request.questionId)
        viewModel.sendUnpinThenImplementPlanIntent(tabId: tabId, questionId: request.questionId, clearContext: clearContext)
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
            UIPasteboard.general.string = planContentPreview ?? planContentInline ?? ""
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

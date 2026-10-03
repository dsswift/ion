import SwiftUI

// MARK: - NotificationsView

struct NotificationsView: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let resourceStore: ResourceStore
    let viewModel: SessionViewModel

    @State private var selectedResource: ResourceItem? = nil
    @State private var showClearAllConfirm = false

    /// The user's per-kind global-tray blocklist, projected from the desktop
    /// `excludedResourceKinds` preference. Empty by default → show every kind.
    /// Only the global/workspace tray honors this; conversation-scoped
    /// resources are never filtered (they live in the attachments panel).
    private var excludedKinds: Set<String> {
        guard let raw = viewModel.serverSettings?.currentValue(for: "excludedResourceKinds")?.value as? [AnyCodable] else {
            return []
        }
        return Set(raw.compactMap { $0.value as? String })
    }

    /// Every workspace-scoped resource across ALL kinds, minus excluded kinds,
    /// newest first. Kind-agnostic: any extension-declared kind appears here
    /// with zero client changes.
    private var notifications: [ResourceItem] {
        let excluded = excludedKinds
        var all: [ResourceItem] = []
        for (kind, items) in resourceStore.items {
            if excluded.contains(kind) || NotificationKinds.isStudioTraffic(kind) { continue }
            for item in items where item.conversationId == nil || item.conversationId?.isEmpty == true {
                all.append(item)
            }
        }
        return all.sorted { $0.createdAt > $1.createdAt }
    }

    /// The unread subset of the global notifications, used to gate the
    /// "Clear All" button and to drive the mark-all-read action.
    private var unreadNotifications: [ResourceItem] {
        notifications.filter { !resourceStore.readIds.contains($0.compositeId) }
    }

    var body: some View {
        NavigationStack {
            Group {
                if notifications.isEmpty {
                    emptyState
                } else {
                    notificationList
                }
            }
            .navigationTitle("Notifications")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                if !unreadNotifications.isEmpty {
                    ToolbarItem(placement: .topBarLeading) {
                        Button("Mark All Read") { showClearAllConfirm = true }
                            .tint(theme.accent)
                    }
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .tint(theme.accent)
                }
            }
            .confirmationDialog(
                "Mark all as read?",
                isPresented: $showClearAllConfirm,
                titleVisibility: .visible
            ) {
                Button("Mark All as Read") { clearAll() }
                Button("Cancel", role: .cancel) {}
            }
            .sheet(item: $selectedResource) { item in
                ResourceDetailView(item: item, resourceStore: resourceStore, viewModel: viewModel)
            }
        }
    }

    /// Mark every currently-unread global notification as read. Updates the
    /// local store in one batch, then fans each read out per item through the
    /// engine's resource broker so the desktop and other subscribers converge.
    /// Reuses the exact per-item mark_read command the rows already send.
    private func clearAll() {
        let unread = unreadNotifications
        guard !unread.isEmpty else { return }
        resourceStore.markAllRead(unread)
        for item in unread {
            viewModel.send(.markResourceRead(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id), intent: .userInitiated)
        }
    }

    // MARK: - Empty state

    private var emptyState: some View {
        VStack(spacing: IonSpace.contentGap) {
            Image(systemName: "bell.slash")
                .font(.system(size: 40)) // design-type: SF Symbol empty-state glyph sized as icon geometry, not text
                .foregroundStyle(.tertiary)
            Text("No Notifications Yet")
                .font(.title3.weight(.semibold))
                .foregroundStyle(.secondary)
            Text("Resources published by your extensions will appear here.")
                .font(.subheadline)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
                .padding(.horizontal, IonSpace.sectionGap)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    // MARK: - Notification list

    private var notificationList: some View {
        List(notifications) { item in
            ResourceRow(item: item, resourceStore: resourceStore, viewModel: viewModel) { selectedResource = $0 }
                .listRowInsets(EdgeInsets(
                    top: IonSpace.compactGap,
                    leading: IonSpace.rowInset,
                    bottom: IonSpace.compactGap,
                    trailing: IonSpace.rowInset
                ))
        }
        .listStyle(.plain)
    }
}

// MARK: - ResourceRow

private struct ResourceRow: View {
    @Environment(\.appTheme) private var theme
    let item: ResourceItem
    let resourceStore: ResourceStore
    let viewModel: SessionViewModel
    let onSelect: (ResourceItem) -> Void

    private var isRead: Bool { resourceStore.readIds.contains(item.compositeId) }
    private var title: String { item.title ?? item.metadata["agentName"] ?? item.kind }
    private var formattedTime: String {
        guard let date = ISO8601DateFormatter().date(from: item.createdAt) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    private var liveItem: ResourceItem {
        resourceStore.items[item.kind]?.first(where: { $0.compositeId == item.compositeId }) ?? item
    }

    var body: some View {
        Button {
            if !isRead {
                resourceStore.markRead(item)
                viewModel.send(.markResourceRead(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id), intent: .userInitiated)
            }
            onSelect(item)
        } label: {
            VStack(alignment: .leading, spacing: IonSpace.hairlineGap) {
                HStack(alignment: .firstTextBaseline, spacing: IonSpace.compactGap) {
                    Circle()
                        .fill(isRead ? Color.clear : theme.accent)
                        .frame(width: 7, height: 7)
                        .padding(.top, 3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                    Text(title)
                        .font(isRead ? IonType.body : IonType.bodyStrong)
                        .foregroundStyle(.primary)
                        .lineLimit(1)
                        .frame(maxWidth: .infinity, alignment: .leading)
                    Text(formattedTime)
                        .font(IonType.metadata)
                        .foregroundStyle(.tertiary)
                }
                Text(liveItem.content.isEmpty ? "Tap to view…" : String(liveItem.content.prefix(120)))
                    .font(IonType.meaning)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .padding(.leading, IonSpace.contentGap)
            }
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing, allowsFullSwipe: true) {
            Button(role: .destructive) {
                resourceStore.deleteItem(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id)
                viewModel.send(.deleteResource(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id), intent: .userInitiated)
            } label: {
                Label("Delete", systemImage: "trash")
            }
        }
    }
}

// MARK: - ResourceDetailView

struct ResourceDetailView: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss
    let item: ResourceItem
    let resourceStore: ResourceStore
    let viewModel: SessionViewModel

    @State private var loadingContent = false
    @State private var contentFailed = false

    private var liveItem: ResourceItem {
        resourceStore.items[item.kind]?.first(where: { $0.compositeId == item.compositeId }) ?? item
    }
    private var title: String { item.title ?? item.metadata["agentName"] ?? item.kind }

    /// The decoded chart, when this resource is one.
    ///
    /// Decoded from the LIVE item so a chart updated while the sheet is open
    /// redraws at the new revision instead of holding the reading the user
    /// opened with. A malformed payload yields nil and falls through to the
    /// markdown path, which shows the raw content rather than nothing at all.
    private var chartContent: ChartResourceContent? {
        guard liveItem.kind == ChartResourceKind.name else { return nil }
        return ChartResourceContent.decode(from: liveItem.content)
    }
    private var formattedTime: String {
        guard let date = ISO8601DateFormatter().date(from: item.createdAt) else { return "" }
        return date.formatted(date: .omitted, time: .shortened)
    }

    var body: some View {
        NavigationStack {
            ScrollView {
                Group {
                    if !liveItem.content.isEmpty {
                        // A chart resource carries a JSON spec, not prose.
                        // Rendering it as markdown would show the user raw
                        // JSON, so the chart kind gets its native renderer and
                        // every other kind keeps the markdown path.
                        if let chart = chartContent {
                            ChartCardView(content: chart)
                                .padding(IonSpace.rowInset)
                                .onAppear { loadingContent = false }
                        } else {
                            MarkdownContentView(blocks: MarkdownFormatter.parse(liveItem.content))
                                .padding(IonSpace.rowInset)
                                .onAppear { loadingContent = false }
                        }
                    } else if contentFailed {
                        HStack(spacing: IonSpace.compactGap) {
                            Image(systemName: "exclamationmark.circle")
                                .foregroundStyle(.secondary)
                            Text("Content unavailable")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                            Spacer()
                            Button("Retry") {
                                contentFailed = false
                                loadingContent = true
                                viewModel.send(.requestResourceContent(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id), intent: .userInitiated)
                            }
                            .font(.caption)
                            .tint(theme.accent)
                        }
                        .padding(IonSpace.rowInset)
                    } else {
                        HStack(spacing: IonSpace.compactGap) {
                            ProgressView()
                                .scaleEffect(0.8)
                            Text("Loading…")
                                .font(.caption)
                                .foregroundStyle(.secondary)
                        }
                        .padding(IonSpace.rowInset)
                    }
                }
                .frame(maxWidth: .infinity, alignment: .leading)
            }
            .navigationTitle(title)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .topBarLeading) {
                    Text(formattedTime)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Done") { dismiss() }
                        .fontWeight(.semibold)
                        .tint(theme.accent)
                }
            }
            .onAppear {
                if liveItem.content.isEmpty && !loadingContent && !contentFailed {
                    loadingContent = true
                    viewModel.send(.requestResourceContent(kind: item.kind, producer: item.producer.isEmpty ? nil : item.producer, resourceId: item.id), intent: .automaticEssential)
                }
            }
            .onChange(of: resourceStore.contentResponseIds) {
                guard loadingContent else { return }
                guard resourceStore.contentResponseIds.contains(item.compositeId) else { return }
                if !liveItem.content.isEmpty {
                    loadingContent = false
                    contentFailed = false
                } else {
                    loadingContent = false
                    contentFailed = true
                }
            }
        }
    }
}

// MARK: - NotificationsBellButton

/// Bell button with unread badge for use in toolbars.
struct NotificationsBellButton: View {
    @Environment(\.appTheme) private var theme
    let resourceStore: ResourceStore
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            ZStack(alignment: .topTrailing) {
                Image(systemName: "bell")
                if resourceStore.unreadCount > 0 {
                    Text(resourceStore.unreadCount > 9 ? "9+" : "\(resourceStore.unreadCount)")
                        .font(.caption2.bold())
                        .foregroundStyle(.white)
                        .padding(3) // design-geometry: 3pt inset; below the 4pt rhythm floor
                        .background(theme.statusError)
                        .clipShape(Circle())
                        .offset(x: 6, y: -6)
                }
            }
        }
    }
}

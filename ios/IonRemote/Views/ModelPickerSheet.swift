import SwiftUI

/// Provider-grouped model picker, at parity with the desktop popover
/// (`desktop/src/renderer/components/ModelPickerPopover.tsx`).
///
/// A `Menu` cannot host a search field, collapsible section headers, or rows
/// that are visible but disabled, so this is a presented sheet. All grouping,
/// filtering, and duplicate-label logic lives in `ModelPickerGrouping` — this
/// view only renders it.
struct ModelPickerSheet: View {
    @Environment(\.appTheme) private var theme
    @Environment(\.dismiss) private var dismiss

    /// Full catalog from the desktop snapshot (already enterprise-filtered by
    /// the desktop's `updateCache`, so no policy filtering is needed here).
    let models: [RemoteModelEntry]
    /// Currently-selected model id — rendered with a checkmark.
    let selectedModelId: String
    /// The global default model — rendered with a star, as on desktop.
    let preferredModelId: String
    /// Optional leading row for a "no explicit choice" sentinel, used by the
    /// Settings engine-default picker ("Same as Conversation" → "").
    var inheritOption: InheritOption?
    let onSelect: (String) -> Void

    /// A sentinel row rendered above the provider sections.
    struct InheritOption {
        let label: String
        let value: String
    }

    /// Persisted collapse state, mirroring the desktop picker's
    /// `localStorage['ion:model-picker-collapsed']`.
    private static let collapsedDefaultsKey = "modelPickerCollapsedProviders"

    @State private var searchText = ""
    @State private var collapsedProviders: Set<String> = Self.loadCollapsed()

    private var isSearching: Bool {
        !searchText.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }

    private var groups: [ModelPickerGrouping.ProviderGroup] {
        ModelPickerGrouping.groups(models: models, searchQuery: searchText)
    }

    var body: some View {
        NavigationStack {
            listContent
                .navigationTitle("Model")
                .navigationBarTitleDisplayMode(.inline)
                .toolbar {
                    ToolbarItem(placement: .cancellationAction) {
                        Button("Cancel") { dismiss() }
                    }
                }
                .modifier(
                    ConditionalSearchable(
                        enabled: ModelPickerGrouping.showSearch(modelCount: models.count),
                        text: $searchText,
                    )
                )
        }
    }

    @ViewBuilder
    private var listContent: some View {
        List {
            if let inherit = inheritOption {
                Section {
                    inheritRow(inherit)
                }
            }

            ForEach(groups) { group in
                Section {
                    // Collapse only applies when browsing. While searching, a
                    // collapsed section would hide a hit the user just typed
                    // for — the desktop suppresses collapse the same way.
                    if isSearching || !collapsedProviders.contains(group.id) {
                        let duplicates = ModelPickerGrouping.duplicateLabels(in: group)
                        ForEach(group.models) { model in
                            modelRow(
                                model: model,
                                hasAuth: group.hasAuth,
                                showRawId: duplicates.contains(model.label),
                            )
                        }
                    }
                } header: {
                    header(for: group)
                }
            }

            if groups.isEmpty {
                Section {
                    Text(isSearching ? "No models found" : "No providers configured")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
            }

            if !isSearching, ModelPickerGrouping.showOtherProvidersHint(models: models) {
                Section {
                    Text("Search to see models from other providers")
                        .font(.caption)
                        .foregroundStyle(.tertiary)
                }
            }
        }
    }

    // MARK: - Rows

    private func inheritRow(_ inherit: InheritOption) -> some View {
        Button {
            pick(inherit.value)
        } label: {
            HStack {
                Text(inherit.label)
                    .foregroundStyle(.primary)
                Spacer()
                if selectedModelId == inherit.value {
                    Image(systemName: "checkmark")
                        .foregroundStyle(theme.accent)
                }
            }
        }
        .buttonStyle(.plain)
    }

    private func header(for group: ModelPickerGrouping.ProviderGroup) -> some View {
        Button {
            // While searching the sections are force-expanded, so a toggle
            // would silently change state the user cannot see.
            guard !isSearching else { return }
            toggleCollapsed(group.id)
        } label: {
            HStack(spacing: 4) {
                Image(systemName: chevronName(for: group))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                Text(group.label)
                    .foregroundStyle(group.hasAuth ? .secondary : .tertiary)
                if !group.hasAuth {
                    Text("⚠ not configured")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Spacer()
                Text("\(group.models.count)")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .disabled(isSearching)
    }

    private func chevronName(for group: ModelPickerGrouping.ProviderGroup) -> String {
        if isSearching { return "chevron.down" }
        return collapsedProviders.contains(group.id) ? "chevron.right" : "chevron.down"
    }

    private func modelRow(model: RemoteModelEntry, hasAuth: Bool, showRawId: Bool) -> some View {
        Button {
            pick(model.id)
        } label: {
            HStack(spacing: 6) {
                if model.id == preferredModelId {
                    Image(systemName: "star.fill")
                        .font(.caption2)
                        .foregroundStyle(theme.statusWarning)
                }
                VStack(alignment: .leading, spacing: 1) {
                    Text(model.label)
                        .foregroundStyle(.primary)
                    if showRawId {
                        Text(model.id)
                            .font(.caption2)
                            .monospaced()
                            .foregroundStyle(.tertiary)
                    }
                }
                if model.modelKind == "image" {
                    badge("image gen")
                }
                if model.isCustom == true {
                    badge("custom")
                }
                Spacer()
                if model.id == selectedModelId {
                    Image(systemName: "checkmark")
                        .foregroundStyle(theme.accent)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        // A model behind an unconfigured provider is shown (so the operator
        // knows it exists) but cannot be chosen — selecting it would dispatch
        // to a provider with no credentials and fail at the engine.
        .disabled(!hasAuth)
        .opacity(hasAuth ? 1.0 : 0.45)
    }

    private func badge(_ text: String) -> some View {
        Text(text)
            .font(.system(size: 9, weight: .medium))
            .padding(.horizontal, 4)
            .padding(.vertical, 1)
            .background(Capsule().fill(Color(.tertiarySystemFill)))
            .foregroundStyle(.secondary)
    }

    // MARK: - Actions

    private func pick(_ id: String) {
        onSelect(id)
        Haptic.success()
        dismiss()
    }

    private func toggleCollapsed(_ providerId: String) {
        withAnimation(.snappy(duration: 0.15)) {
            if collapsedProviders.contains(providerId) {
                collapsedProviders.remove(providerId)
            } else {
                collapsedProviders.insert(providerId)
            }
        }
        UserDefaults.standard.set(Array(collapsedProviders), forKey: Self.collapsedDefaultsKey)
    }

    private static func loadCollapsed() -> Set<String> {
        Set(UserDefaults.standard.stringArray(forKey: collapsedDefaultsKey) ?? [])
    }
}

/// Applies `.searchable` only when the catalog is large enough to warrant it.
/// A conditional modifier needs its own type — branching on `if` inside a view
/// body would give SwiftUI two structurally different view trees and reset the
/// search state on every toggle.
private struct ConditionalSearchable: ViewModifier {
    let enabled: Bool
    @Binding var text: String

    func body(content: Content) -> some View {
        if enabled {
            content.searchable(
                text: $text,
                placement: .navigationBarDrawer(displayMode: .always),
                prompt: "Search models…",
            )
        } else {
            content
        }
    }
}

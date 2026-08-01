import Foundation

/// Pure grouping/filtering logic behind the provider-grouped model picker.
///
/// Lives outside the SwiftUI body so every rule the desktop picker
/// (`desktop/src/renderer/components/ModelPickerPopover.tsx`) implements is
/// unit-testable here rather than re-derived inside a view. The rules mirrored
/// from the desktop are:
///
///   - group by `providerId`, ordered by first appearance in the model list
///     (the desktop builds a `Map` and iterates insertion order);
///   - with no search query, show only models whose provider is authenticated;
///   - with a query, search ALL models (this is how an unconfigured provider's
///     models become visible) matching on id or label, case-insensitively;
///   - flag labels that collide inside one group so the row can disambiguate
///     with the raw model id.
enum ModelPickerGrouping {

    /// One provider's section in the picker.
    struct ProviderGroup: Identifiable, Equatable {
        /// Provider id — the section's stable identity and collapse key.
        let id: String
        /// Human-facing header text.
        let label: String
        /// Whether the provider has credentials. False ⇒ the section renders
        /// the "not configured" marker and its rows are inert.
        let hasAuth: Bool
        let models: [RemoteModelEntry]
    }

    /// Number of models above which the picker offers a search field. Matches
    /// the desktop's `showSearch = models.length > 6`.
    static let searchThreshold = 6

    /// Header text for a provider: the desktop-resolved `providerLabel` when
    /// present, else the capitalized provider id.
    ///
    /// There is deliberately no built-in provider-name table on iOS. The
    /// desktop resolves the name once at projection time (honoring the
    /// operator's `engine.json` displayName) and flattens it onto every model,
    /// so a second table here could only ever drift from it. The fallback
    /// exists for a desktop that predates the `providerLabel` field.
    static func providerLabel(for model: RemoteModelEntry) -> String {
        if let label = model.providerLabel, !label.isEmpty {
            return label
        }
        return capitalizedId(model.providerId)
    }

    /// Capitalize the first character only, leaving the rest untouched
    /// ("skunkworks" → "Skunkworks"), matching the desktop's final fallback.
    private static func capitalizedId(_ id: String) -> String {
        guard let first = id.first else { return id }
        return first.uppercased() + id.dropFirst()
    }

    /// Whether a model matches a search query on its id or its display label.
    static func matches(model: RemoteModelEntry, query: String) -> Bool {
        let needle = query.lowercased()
        return model.id.lowercased().contains(needle)
            || model.label.lowercased().contains(needle)
    }

    /// Build the picker's sections.
    ///
    /// An empty/whitespace-only `searchQuery` yields the authenticated
    /// providers only; a non-empty one searches the full list so models behind
    /// an unconfigured provider are discoverable (and are then rendered
    /// disabled by the view, per the group's `hasAuth`).
    static func groups(models: [RemoteModelEntry], searchQuery: String) -> [ProviderGroup] {
        let trimmed = searchQuery.trimmingCharacters(in: .whitespacesAndNewlines)
        let isSearching = !trimmed.isEmpty

        let filtered = models.filter { model in
            isSearching ? matches(model: model, query: trimmed) : model.hasAuth
        }

        // Preserve first-appearance order; a dictionary alone would not.
        var order: [String] = []
        var byProvider: [String: [RemoteModelEntry]] = [:]
        for model in filtered {
            if byProvider[model.providerId] == nil {
                order.append(model.providerId)
                byProvider[model.providerId] = []
            }
            byProvider[model.providerId]?.append(model)
        }

        return order.compactMap { providerId in
            guard let entries = byProvider[providerId], let first = entries.first else { return nil }
            return ProviderGroup(
                id: providerId,
                label: providerLabel(for: first),
                // Auth is a provider-level fact flattened onto every model, so
                // any member of the group answers for the whole group.
                hasAuth: first.hasAuth,
                models: entries,
            )
        }
    }

    /// Display labels that appear more than once WITHIN a single group. The
    /// view appends the raw model id to these rows so a gateway copy of a
    /// model is distinguishable from the provider's own. Scoped per group,
    /// matching the desktop — the same label under two different providers is
    /// already disambiguated by its section header.
    static func duplicateLabels(in group: ProviderGroup) -> Set<String> {
        var counts: [String: Int] = [:]
        for model in group.models {
            counts[model.label, default: 0] += 1
        }
        return Set(counts.filter { $0.value > 1 }.keys)
    }

    /// Whether the picker shows its search field.
    static func showSearch(modelCount: Int) -> Bool {
        modelCount > searchThreshold
    }

    /// Whether to show the "search to see models from other providers" hint —
    /// true only when the unsearched (authenticated) list is a strict subset of
    /// everything available, i.e. searching would actually reveal something.
    static func showOtherProvidersHint(models: [RemoteModelEntry]) -> Bool {
        let authedCount = models.filter(\.hasAuth).count
        return authedCount > 0 && authedCount < models.count
    }
}

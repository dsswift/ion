import Foundation

/// The settings this phone keeps itself (Personal and Device scope) that the
/// connected server's schema files on one page, grouped by that page's
/// sections in the server's order.
enum ClientOwnedPageContent {

    struct Group: Identifiable, Equatable {
        let id: String
        /// Nil when the server did not describe the section.
        let label: String?
        let keys: [String]
    }

    static func groups(in state: ServerSettingsState, pageId: String) -> [Group] {
        let entries = state.clientOwnedEntries().filter { $0.page == pageId }
        guard !entries.isEmpty else { return [] }
        let sections = state.pages.first { $0.id == pageId }?.sections ?? []
        var groups: [Group] = sections.compactMap { section in
            let keys = entries.filter { $0.section == section.id }.map(\.key)
            return keys.isEmpty ? nil : Group(id: section.id, label: section.label, keys: keys)
        }
        // A section this build's snapshot does not describe still shows its rows.
        let known = Set(sections.map(\.id))
        let rest = entries.filter { !known.contains($0.section ?? "") }.map(\.key)
        if !rest.isEmpty { groups.append(Group(id: "\(pageId).other", label: nil, keys: rest)) }
        return groups
    }
}

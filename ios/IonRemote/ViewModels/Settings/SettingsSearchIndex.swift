import Foundation

/// Matches a Settings search against the phone's own pages and the connected
/// server's pages, sections, and projected settings.
///
/// Every word of the query must appear in an item's title, keywords, or
/// description. Title matches rank first: a title that starts with the query,
/// then a title holding every word, then the rest.
enum SettingsSearchIndex {

    static let limit = 50

    private struct Item {
        let result: SettingsSearchResult
        /// Lowercased text beyond the title a match may come from.
        let extra: String
    }

    static func results(for query: String, state: ServerSettingsState?, serverLabel: String?) -> [SettingsSearchResult] {
        let needle = query.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
        let words = needle.split(whereSeparator: \.isWhitespace).map(String.init)
        guard !words.isEmpty else { return [] }
        var ranked: [(rank: Int, order: Int, result: SettingsSearchResult)] = []
        for (order, item) in items(state: state, serverLabel: serverLabel).enumerated() {
            let title = item.result.title.lowercased()
            let haystack = title + " " + item.extra
            guard words.allSatisfy({ haystack.contains($0) }) else { continue }
            let rank = title.hasPrefix(needle) ? 0 : words.allSatisfy({ title.contains($0) }) ? 1 : 2
            ranked.append((rank, order, item.result))
        }
        return ranked
            .sorted { $0.rank != $1.rank ? $0.rank < $1.rank : $0.order < $1.order }
            .prefix(limit)
            .map(\.result)
    }

    private static func items(state: ServerSettingsState?, serverLabel: String?) -> [Item] {
        var out: [Item] = []
        var seen = Set<String>()
        func add(_ item: Item) {
            if seen.insert(item.result.id).inserted { out.append(item) }
        }

        for page in PhoneSettingsPage.allCases {
            add(Item(
                result: SettingsSearchResult(id: "phone:\(page.rawValue)", title: page.title, detail: headingName(page), destination: .phone(page)),
                extra: page.keywords.joined(separator: " ").lowercased()
            ))
        }
        guard let state else { return out }
        let server = serverLabel ?? "Server"
        let serverPages = state.pages.filter { $0.scope == .server }
        let serverPageIds = Set(serverPages.map(\.id))

        for page in serverPages {
            add(Item(
                result: SettingsSearchResult(id: "server:\(page.id)", title: page.label, detail: server, destination: .server(pageId: page.id)),
                extra: ""
            ))
            for section in page.sections where section.label != page.label {
                add(Item(
                    result: SettingsSearchResult(id: "server:\(page.id)#\(section.id)", title: section.label, detail: "\(server) › \(page.label)", destination: .server(pageId: page.id)),
                    extra: ""
                ))
            }
        }

        for entry in state.schema {
            let destination: SettingsSearchResult.Destination
            let detail: String
            if PersonalPreferencesStore.isClientOwned(scope: entry.scope), let phonePage = PhoneSettingsPage.owning(schemaPageId: entry.page) {
                destination = .phone(phonePage)
                detail = "\(headingName(phonePage)) › \(phonePage.title)"
            } else if let pageId = entry.page, serverPageIds.contains(pageId), let page = serverPages.first(where: { $0.id == pageId }) {
                destination = .server(pageId: pageId)
                detail = "\(server) › \(page.label)"
            } else {
                continue
            }
            add(Item(
                result: SettingsSearchResult(id: "setting:\(entry.key)", title: entry.label, detail: detail, destination: destination),
                extra: entry.description.lowercased()
            ))
        }
        return out
    }

    private static func headingName(_ page: PhoneSettingsPage) -> String {
        switch page.heading {
        case .thisPhone: return "This iPhone"
        case .you: return "You"
        }
    }
}

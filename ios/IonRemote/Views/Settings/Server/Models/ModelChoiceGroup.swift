import Foundation

/// The models one provider offers a tier picker, plus any saved value the
/// engine no longer lists, marked unavailable so the picker never
/// misreports what is saved.
struct ModelChoiceGroup: Equatable, Identifiable {

    struct Choice: Equatable, Identifiable {
        let value: String
        let label: String
        let unavailable: Bool
        var id: String { value }
    }

    let providerId: String
    let label: String
    let choices: [Choice]
    var id: String { providerId }

    /// Provider → choices, in the engine's order, with each `configured`
    /// value it does not list added under the provider its id names.
    static func build(models: [ServerModelEntry], providers: [ServerProviderEntry], configured: [String]) -> [ModelChoiceGroup] {
        var order: [String] = []
        var byProvider: [String: [Choice]] = [:]
        for model in models {
            if byProvider[model.providerId] == nil { order.append(model.providerId) }
            byProvider[model.providerId, default: []].append(Choice(value: model.id, label: model.id, unavailable: false))
        }
        let known = Set(models.map(\.id))
        for value in configured where !value.isEmpty && !known.contains(value) {
            let providerId = value.firstIndex(of: "/").map { String(value[..<$0]) } ?? "Unknown"
            if byProvider[providerId] == nil { order.append(providerId) }
            if byProvider[providerId]?.contains(where: { $0.value == value }) == true { continue }
            byProvider[providerId, default: []].append(Choice(value: value, label: "\(value) (unavailable)", unavailable: true))
        }
        return order.map { id in
            ModelChoiceGroup(
                providerId: id,
                label: id == "Unknown" ? id : ServerProviderEntry.displayName(for: id, in: providers),
                choices: byProvider[id] ?? []
            )
        }
    }
}

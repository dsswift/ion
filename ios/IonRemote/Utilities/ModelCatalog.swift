import Foundation

/// Finding a model in the catalog the server sent, from the model id a
/// conversation carries.
///
/// The two do not always spell the model the same way. The catalog lists a
/// model under its provider with a bare id (`claude-fable-5-1`, provider
/// `anthropic`); a conversation's resolved model can come back
/// provider-qualified (`anthropic/claude-fable-5-1`), because that is the
/// form that routes unambiguously. Every surface that needs the model's
/// label, context window, or thinking levels has to bridge that, and each
/// used to compare ids exactly: a qualified id matched nothing, so the
/// composer printed the raw id and resolved the thinking control as
/// unavailable.
///
/// The desktop's counterpart is `resolveLegacyModelId` in
/// `packages/shared/src/model-identity.ts`.
enum ModelCatalog {

    /// The catalog entry for `modelId`, or nil when the catalog has none.
    ///
    /// An exact id match wins. Otherwise a `provider/model` id matches the
    /// entry with that bare id under that provider; failing that, the bare id
    /// alone when exactly one provider offers it. Two providers offering the
    /// same bare id with neither named is ambiguous and matches nothing,
    /// rather than guessing which one the conversation runs on.
    static func entry(for modelId: String, in models: [RemoteModelEntry]) -> RemoteModelEntry? {
        guard !modelId.isEmpty else { return nil }
        if let exact = models.first(where: { $0.id == modelId }) { return exact }
        guard let slash = modelId.firstIndex(of: "/") else { return nil }
        let provider = String(modelId[..<slash])
        let bare = String(modelId[modelId.index(after: slash)...])
        if let scoped = models.first(where: { $0.id == bare && $0.providerId == provider }) { return scoped }
        let bareMatches = models.filter { $0.id == bare }
        return bareMatches.count == 1 ? bareMatches[0] : nil
    }

    /// What to show for `modelId` in a compact control: the catalog's label
    /// when the model is known, otherwise the id without its provider prefix.
    /// The provider is the picker's section heading, not part of the name.
    static func displayLabel(for modelId: String, in models: [RemoteModelEntry]) -> String {
        if let entry = entry(for: modelId, in: models) { return entry.label }
        guard let slash = modelId.firstIndex(of: "/") else { return modelId }
        return String(modelId[modelId.index(after: slash)...])
    }
}

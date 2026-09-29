import Foundation

/// One `studio_action` a command turns into.
struct StudioActionCall: Equatable, Sendable {
    var action: String
    var args: [JSONValue] = []
    /// The tab an action with no tab argument should act on.
    var activeTabId: String?
    /// Nil uses the connection's own action timeout.
    var timeoutSeconds: Double?
    /// A W3C traceparent the frame carrying this call sets on its outer
    /// envelope, where a relay reads it to record its forward span.
    var traceparent: String?
}

/// What sending one `RemoteCommand` means on the Studio wire.
enum StudioCommandRequest: Equatable, Sendable {
    /// Send the first call, then each of `followUps` right behind it without
    /// waiting for the first result. Every call's outcome is handed to the
    /// mapping, which says what events it becomes and whether another call
    /// follows it (`next(for:after:result:)`).
    case action(StudioActionCall, followUps: [StudioActionCall] = [])
    /// Send the call repeatedly, bumping the `offset` member of its single
    /// object argument, until a result says `hasMore` is false. The mapping is
    /// handed one value whose `content` is every page joined, so a command
    /// whose reply is one whole string stays one event.
    case pagedAction(StudioActionCall)
    /// Ask for the first paint again (`studio_snapshot_request`).
    case snapshotRequest
    /// Ask for a page of a transcript (`studio_body_request`). The answer comes
    /// back as a `studio_body` frame, which `StudioEventMapper` turns into the
    /// conversation-history event.
    case bodyRequest(StudioBodyRequest)
    /// Nothing is sent, deliberately. `reason` is logged.
    case drop(reason: String)
}

/// The table from `RemoteCommand` to the Studio wire, and from an action's
/// outcome back to the events the view model expects as that command's reply.
protocol StudioCommandMapping: Sendable {
    /// Nil means this mapping has no entry for the command.
    func request(for command: RemoteCommand) -> StudioCommandRequest?
    /// The events `call`'s value stands for. `call` is named because one
    /// command can make several calls and each answers a different part of the
    /// reply the older wire pushed.
    func events(for command: RemoteCommand, call: StudioActionCall, result: JSONValue) -> [RemoteEvent]
    /// The events that stand in for the command's reply when `call` failed.
    func events(for command: RemoteCommand, call: StudioActionCall, failure: StudioActionFailure) -> [RemoteEvent]
    /// A further call this command needs now that `call` has been answered —
    /// a read that refreshes what a write changed, or a step whose arguments
    /// are in the previous step's value. Nil ends the chain.
    func next(for command: RemoteCommand, after call: StudioActionCall, result: JSONValue) -> StudioActionCall?
}

extension StudioCommandMapping {
    func next(for command: RemoteCommand, after call: StudioActionCall, result: JSONValue) -> StudioActionCall? { nil }
}

// MARK: - Building calls

extension StudioActionCall {
    /// A call with positional arguments, as most forwarded store actions take.
    static func positional(_ action: String, _ args: JSONValue...) -> StudioActionCall {
        StudioActionCall(action: action, args: args)
    }

    /// A call with one object argument. A nil member is left out entirely, so
    /// an absent option reads as absent rather than as an explicit null.
    static func fields(_ action: String, _ members: [String: JSONValue?]) -> StudioActionCall {
        StudioActionCall(action: action, args: [.object(members.compactMapValues { $0 })])
    }
}

extension JSONValue {
    /// A string that may be absent. Absent becomes JSON `null`, which is what a
    /// positional argument needs when a later argument follows it.
    static func maybe(_ value: String?) -> JSONValue { value.map(JSONValue.string) ?? .null }

    /// An `Encodable` payload the mapping passes through without reading it
    /// (a questions patch, an elicitation response, a settings value). A value
    /// that will not encode becomes `null` and says so.
    static func passthrough<T: Encodable>(_ value: T?, what: String) -> JSONValue {
        guard let value else { return .null }
        do {
            return try JSONValue.encoding(value)
        } catch {
            DiagnosticLog.log("studio mapping: argument did not encode, sent as null", tag: "studio.map", level: .error, fields: [
                "what": what, "error": String(describing: error)
            ])
            return .null
        }
    }
}

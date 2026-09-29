import XCTest
@testable import IonRemote

/// The drift guard between this client's command table and the shared map.
///
/// `packages/shared/src/studio-wire/phone-command-map.json` says, for every
/// `desktop_*` command, which `studio_action` (or Studio frame) replaces it.
/// The server pins that file against its own action registry
/// (`phone-command-parity.test.ts`); this pins it against the Swift table, so
/// the two clients of one document cannot drift apart.
///
/// Nothing here is hand-copied: the command list comes from
/// `RemoteCommand.TypeKey`, the map from disk.
final class StudioCommandMapTests: XCTestCase {

    private struct Entry: Decodable {
        let action: String?
        let alsoActions: [String]?
    }

    private struct Map: Decodable {
        let commands: [String: Entry]
    }

    /// `phone-command-map.json`, found by walking up from this source file.
    private func loadMap(file: StaticString = #filePath) throws -> [String: Entry] {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        for _ in 0..<8 {
            let candidate = dir.appendingPathComponent("packages/shared/src/studio-wire/phone-command-map.json")
            if FileManager.default.fileExists(atPath: candidate.path) {
                return try JSONDecoder().decode(Map.self, from: Data(contentsOf: candidate)).commands
            }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("phone-command-map.json not found above \(file)")
    }

    /// Every action name the table uses for one command, including the calls
    /// that follow the first one.
    private func actions(for command: RemoteCommand, mapping: StudioTransportCommandMapping) -> [String] {
        guard let request = mapping.request(for: command) else { return [] }
        switch request {
        case .action(let primary, let followUps):
            return ([primary] + followUps).map(\.action) + chained(command, after: primary, mapping: mapping)
        case .pagedAction(let call):
            return [call.action]
        case .snapshotRequest, .bodyRequest, .drop:
            return []
        }
    }

    /// The calls `next` adds. Each step is fed the shapes a real answer has, so
    /// a chain that only continues on a non-null value is still walked.
    private func chained(_ command: RemoteCommand, after call: StudioActionCall, mapping: StudioTransportCommandMapping) -> [String] {
        var found: [String] = []
        var current = call
        let answers: [JSONValue] = [.string("/tmp/bench"), .object(["ok": .bool(true)])]
        for _ in 0..<4 {
            guard let next = answers.compactMap({ mapping.next(for: command, after: current, result: $0) }).first else { break }
            found.append(next.action)
            current = next
        }
        return found
    }

    // MARK: - Tests

    func testTheMapCoversEveryCommandThisClientCanSend() throws {
        let entries = try loadMap()
        let missing = RemoteCommand.TypeKey.allCases.map(\.rawValue).filter { entries[$0] == nil }
        XCTAssertEqual(missing, [], "commands with no entry in phone-command-map.json")
    }

    func testEveryEntryNamesACommandThisClientHasOrOneItDeliberatelyDropped() throws {
        let entries = try loadMap()
        let sendable = Set(RemoteCommand.TypeKey.allCases.map(\.rawValue))
        let never = StudioTransportCommandMapping.commandsThisClientNeverSends
        XCTAssertEqual(never.intersection(sendable).sorted(), [], "listed as never sent, but this client has the command")
        XCTAssertEqual(
            Set(entries.keys).subtracting(sendable).subtracting(never).sorted(), [],
            "entries for commands this client neither sends nor declares retired")
    }

    func testEveryCommandHasARequestAndNamesOnlyActionsTheMapLists() throws {
        let entries = try loadMap()
        let mapping = StudioTransportCommandMapping(benchPath: { _, _ in "/tmp/bench" })
        var unmapped: [String] = []
        var undocumented: [String] = []
        for sample in StudioCommandSamples.all {
            let wireName = try StudioCommandSamples.wireName(of: sample)
            guard let request = mapping.request(for: sample) else {
                unmapped.append(wireName)
                continue
            }
            if case .drop = request, entries[wireName]?.action != nil {
                unmapped.append("\(wireName) (dropped, but the map names an action for it)")
            }
            let documented = Set([entries[wireName]?.action].compactMap { $0 } + (entries[wireName]?.alsoActions ?? []))
            for action in actions(for: sample, mapping: mapping) where !documented.contains(action) {
                undocumented.append("\(wireName) -> \(action)")
            }
        }
        XCTAssertEqual(unmapped.sorted(), [], "commands the Swift table has no request for")
        XCTAssertEqual(undocumented.sorted(), [], "actions the Swift table sends that the map does not list")
    }

    func testTheSamplesCoverEveryCommandSoTheCheckAboveIsNotVacuous() throws {
        let covered = try Set(StudioCommandSamples.all.map(StudioCommandSamples.wireName(of:)))
        let all = Set(RemoteCommand.TypeKey.allCases.map(\.rawValue))
        XCTAssertEqual(all.subtracting(covered).sorted(), [], "commands with no sample")
        XCTAssertEqual(covered.subtracting(all).sorted(), [], "samples that encode to no known command")
    }
}

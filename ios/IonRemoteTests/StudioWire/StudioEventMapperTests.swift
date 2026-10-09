import XCTest
@testable import IonRemote

/// What arrives on a thin connection becomes the same `RemoteEvent`s the
/// `desktop_*` wire produced for the same JSON.
final class StudioEventMapperTests: XCTestCase {

    private let mapper = StudioEventMapper()

    /// One sample of each event a first paint is made of.
    private let firstPaint: [String: String] = [
        "desktop_snapshot": #"{"type":"desktop_snapshot","tabs":[],"recentDirectories":["/srv/app"]}"#,
        "desktop_settled_tabs": #"{"type":"desktop_settled_tabs","settledTabs":[]}"#,
        "desktop_engine_profiles": #"{"type":"desktop_engine_profiles","profiles":[]}"#,
        "desktop_settings_snapshot": #"{"type":"desktop_settings_snapshot","settings":{"aiGeneratedTitles":false},"schema":[],"groups":[],"canManageEnvironment":true}"#,
        "desktop_theme_manifest": #"{"type":"desktop_theme_manifest","themes":[],"hash":"h-1"}"#,
        "desktop_terminal_snapshot": #"{"type":"desktop_terminal_snapshot","tabId":"tab-1","instances":[],"activeInstanceId":"inst-1"}"#,
        "desktop_presence": #"{"type":"desktop_presence","entries":[],"driving":{"tab-1":"user:one"}}"#
    ]

    private func thinEvent(_ json: String) throws -> StudioInbound {
        let payload = try JSONDecoder().decode(JSONValue.self, from: Data(json.utf8))
        return .event(StudioEvent(channel: studioThinEventChannel, payload: payload))
    }

    /// An event as canonical JSON, so two events can be compared without `Equatable`.
    private func canonical(_ event: RemoteEvent) throws -> String {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return String(decoding: try encoder.encode(event), as: UTF8.self)
    }

    func testEachFirstPaintEventDecodesToWhatTheOlderWireProducedForTheSameJSON() throws {
        for (type, json) in firstPaint {
            let direct = try JSONDecoder().decode(RemoteEvent.self, from: Data(json.utf8))
            let output = mapper.map(try thinEvent(json))
            XCTAssertEqual(output.events.count, 1, type)
            XCTAssertFalse(output.needsResync, type)
            let mapped = try XCTUnwrap(output.events.first, type)
            XCTAssertEqual(mapped.typeKey, type)
            XCTAssertEqual(try canonical(mapped), try canonical(direct), type)
        }
    }

    /// Settled conversations arrive on their own payload rather than inside
    /// `desktop_snapshot`, and carry the complete set every time.
    func testSettledConversationsArriveAsTheirOwnCompleteSet() throws {
        let json = #"{"type":"desktop_settled_tabs","settledTabs":[{"id":"t-1","title":"Closed","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"conversationInstances":[{"id":"i-t-1","label":"Main"}],"activeConversationInstanceId":"i-t-1"},{"id":"t-2","title":"Also closed","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"conversationInstances":[{"id":"i-t-2","label":"Main"}],"activeConversationInstanceId":"i-t-2"}]}"#
        let output = mapper.map(try thinEvent(json))
        XCTAssertFalse(output.needsResync)
        guard case .settledTabs(let tabs)? = output.events.first else {
            return XCTFail("a settled payload did not map to the settled event")
        }
        XCTAssertEqual(tabs.map(\.id), ["t-1", "t-2"])
    }

    /// One unreadable settled record costs that record, never the whole set.
    func testAMalformedSettledRecordIsDroppedAndTheRestSurvive() throws {
        let json = #"{"type":"desktop_settled_tabs","settledTabs":[{"id":"t-1","title":"Closed","customTitle":null,"status":"idle","workingDirectory":"/tmp","permissionMode":"auto","permissionQueue":[],"lastMessage":null,"contextTokens":null,"conversationInstances":[{"id":"i-t-1","label":"Main"}],"activeConversationInstanceId":"i-t-1"},{"title":"no id"}]}"#
        let output = mapper.map(try thinEvent(json))
        XCTAssertFalse(output.needsResync)
        guard case .settledTabs(let tabs)? = output.events.first else {
            return XCTFail("a settled payload did not map to the settled event")
        }
        XCTAssertEqual(tabs.map(\.id), ["t-1"])
    }

    func testAnUnknownEventTypeIsDroppedWithoutAResync() throws {
        let output = mapper.map(try thinEvent(#"{"type":"desktop_not_a_thing_yet","tabId":"tab-1"}"#))
        XCTAssertTrue(output.events.isEmpty)
        XCTAssertFalse(output.needsResync)
    }

    func testAKnownTypeWithABrokenPayloadIsDroppedAndAsksForAResync() throws {
        // `themes` must be a list, and `hash` is missing.
        let output = mapper.map(try thinEvent(#"{"type":"desktop_theme_manifest","themes":"not-a-list"}"#))
        XCTAssertTrue(output.events.isEmpty)
        XCTAssertTrue(output.needsResync)
    }

    func testAPayloadWithNoTypeIsDroppedAndAsksForAResync() throws {
        let output = mapper.map(try thinEvent(#"{"tabId":"tab-1"}"#))
        XCTAssertTrue(output.events.isEmpty)
        XCTAssertTrue(output.needsResync)
    }

    func testTheOtherThinChannelsProduceNothing() {
        for channel in ["studio:push-doorbell", "studio:tabs-sync"] {
            let output = mapper.map(.event(StudioEvent(channel: channel, payload: .object(["tabId": .string("tab-1")]))))
            XCTAssertTrue(output.events.isEmpty, channel)
            XCTAssertTrue(output.adminEvents.isEmpty, channel)
            XCTAssertFalse(output.needsResync, channel)
        }
    }

    /// Admin channels go to the admin sink uninterpreted, and never become
    /// thin events.
    func testAdminChannelsAreRoutedAsTheyArrived() {
        for channel in ServerAdminEvent.channels {
            let payload: JSONValue = .object(["jobId": .string("job-1")])
            let output = mapper.map(.event(StudioEvent(channel: channel, payload: payload)))
            XCTAssertTrue(output.events.isEmpty, channel)
            XCTAssertFalse(output.needsResync, channel)
            XCTAssertEqual(output.adminEvents, [StudioEvent(channel: channel, payload: payload)], channel)
        }
    }

    // MARK: - The client's own log

    /// The server asks for this client's log lines on its own channel. Before
    /// this mapping the request fell through to the unexpected-channel branch
    /// and was dropped, so the server asked every few seconds forever and the
    /// phone's log never left the device.
    func testAClientLogRequestBecomesTheDiagnosticExportEvent() throws {
        let output = mapper.map(.event(StudioEvent(
            channel: studioClientLogRequestChannel,
            payload: .object(["sinceSeq": .int(4321)])
        )))
        XCTAssertFalse(output.needsResync)
        XCTAssertEqual(output.events.count, 1)
        guard case .requestDiagnosticLogs(let sinceSeq)? = output.events.first else {
            return XCTFail("a client log request must ask for the diagnostic export")
        }
        XCTAssertEqual(sinceSeq, 4321)
    }

    /// A request with no cursor is a full export, not a dropped event.
    func testAClientLogRequestWithNoCursorAsksFromTheStart() throws {
        let output = mapper.map(.event(StudioEvent(
            channel: studioClientLogRequestChannel, payload: .object([:])
        )))
        guard case .requestDiagnosticLogs(let sinceSeq)? = output.events.first else {
            return XCTFail("a cursorless request must still ask for the export")
        }
        XCTAssertEqual(sinceSeq, 0)
    }

    // MARK: - Transcript pages

    private let rows: [JSONValue] = [
        .object(["id": .string("m-1"), "role": .string("user"), "content": .string("hello"), "timestamp": .int(1_700_000_000_000)]),
        .object(["id": .string("m-2"), "role": .string("assistant"), "content": .string("hi"), "timestamp": .int(1_700_000_000_500)])
    ]

    private func body(rows: [JSONValue], anchor: StudioBodyAnchor?, startIndex: Int = 0, total: Int = 2, stream: Bool = true) -> StudioBody {
        var body = StudioBody(tabId: "tab-1", instanceId: "main", rows: rows, hasMore: startIndex > 0, cursor: nil, anchor: anchor)
        if stream {
            body.streamId = "tab:tab-1:main"
            body.epoch = "e1"
            body.rev = 7
            body.total = total
            body.startIndex = startIndex
        }
        return body
    }

    private func page(_ body: StudioBody) throws -> TranscriptPage {
        let output = mapper.map(.body(body))
        guard case .transcriptPage(let page)? = output.events.first else {
            XCTFail("a body did not map to a transcript page: \(output.events)")
            throw XCTSkip("no page")
        }
        return page
    }

    func testTheNewestPageCarriesItsStreamPosition() throws {
        let page = try page(body(rows: rows, anchor: .newest))
        XCTAssertTrue(page.isNewest)
        XCTAssertEqual(page.rows.map(\.id), ["m-1", "m-2"])
        XCTAssertEqual(page.streamId, "tab:tab-1:main")
        XCTAssertEqual(page.epoch, "e1")
        XCTAssertEqual(page.rev, 7)
        XCTAssertEqual(page.total, 2)
        XCTAssertEqual(page.startIndex, 0)
    }

    func testAnUnchangedReplyIsAPageThatCarriesNoRows() throws {
        var reply = body(rows: [], anchor: .newest)
        reply.startIndex = nil
        reply.unchanged = true
        let page = try page(reply)
        XCTAssertTrue(page.unchanged)
        XCTAssertTrue(page.isNewest)
        XCTAssertEqual(page.epoch, "e1")
        XCTAssertEqual(page.rev, 7)
    }

    func testAnOlderPageIsNotTheNewest() throws {
        let page = try page(body(rows: rows, anchor: .before("m-9"), startIndex: 4, total: 9))
        XCTAssertFalse(page.isNewest)
        XCTAssertTrue(page.hasOlder)
        XCTAssertEqual(page.startIndex, 4)
    }

    func testAReplyWithNoStreamIsUnavailable() {
        let output = mapper.map(.body(body(rows: [], anchor: .newest, stream: false)))
        guard case .transcriptUnavailable(let tabId, _, _, let isNewest, let reason)? = output.events.first else {
            return XCTFail("a reply with no stream must say the transcript is unavailable")
        }
        XCTAssertEqual(tabId, "tab-1")
        XCTAssertTrue(isNewest)
        XCTAssertEqual(reason, "no_stream")
    }

    /// A page with a hole in it no longer lines up with the revisions that
    /// follow, so a row that does not decode fails the page rather than
    /// being skipped.
    func testARowThatDoesNotDecodeFailsThePage() {
        let broken: JSONValue = .object(["role": .string("user")])
        let output = mapper.map(.body(body(rows: [rows[0], broken, rows[1]], anchor: .newest, total: 3)))
        guard case .transcriptUnavailable(_, _, _, _, let reason)? = output.events.first else {
            return XCTFail("a page with an undecodable row must not map to a page")
        }
        XCTAssertEqual(reason, "decode_failed")
    }

    func testFramesThatCarryNoEventsMapToNothing() {
        XCTAssertTrue(mapper.map(.snapshot(.object([:]))).events.isEmpty)
        XCTAssertTrue(mapper.map(.environmentPolicy(StudioEnvironmentPolicy(enterprisePolicy: .null, settingsHiddenGroups: [], policyHash: "p"))).events.isEmpty)
    }
}

import XCTest
@testable import IonRemote

/// The Swift codec against the wire's golden fixtures
/// (`packages/shared/src/studio-wire/__fixtures__/v1`): every frame decodes,
/// and encodes back to the same JSON.
final class StudioFrameCodecTests: XCTestCase {

    private func fixture(_ name: String) throws -> String {
        let url = try StudioWireFixtures.directory("v1").appendingPathComponent(name)
        return try String(contentsOf: url, encoding: .utf8)
    }

    private func jsonObject(_ text: String) throws -> NSDictionary {
        try XCTUnwrap(JSONSerialization.jsonObject(with: Data(text.utf8)) as? NSDictionary)
    }

    func testEveryFixtureRoundTrips() throws {
        let directory = try StudioWireFixtures.directory("v1")
        let names = try FileManager.default.contentsOfDirectory(atPath: directory.path).filter { $0.hasSuffix(".json") }.sorted()
        XCTAssertFalse(names.isEmpty, "no fixtures found in \(directory.path)")
        for name in names {
            let original = try fixture(name)
            let frame = try StudioFrame.decode(text: original)
            XCTAssertTrue(name.hasPrefix(frame.wireType), "\(name) decoded as \(frame.wireType)")
            let reencoded = try frame.encodedText()
            XCTAssertEqual(try jsonObject(reencoded), try jsonObject(original), "\(name) did not survive a round trip")
            XCTAssertEqual(try StudioFrame.decode(text: reencoded), frame, "\(name) decodes differently the second time")
        }
    }

    func testThinHelloFixtureIsTheHelloThisClientBuilds() throws {
        let frame = try StudioFrame.decode(text: try fixture("studio_hello.thin.json"))
        let built = StudioHello.thinMobile(
            clientId: "phone-a1b2c3d4e5f60718",
            credential: .paired(clientId: "phone-a1b2c3d4e5f60718", proof: "cHJvb2Y=")
        )
        XCTAssertEqual(frame, .hello(built))
        XCTAssertEqual(built.clientKind, "mobile")
        XCTAssertEqual(built.view, "thin")
    }

    func testThinEventKeepsItsPayloadRaw() throws {
        guard case .event(let event) = try StudioFrame.decode(text: try fixture("studio_event.thin.json")) else {
            return XCTFail("not an event")
        }
        XCTAssertEqual(event.channel, studioThinEventChannel)
        XCTAssertEqual(event.payload["type"]?.stringValue, "desktop_working_message")
        XCTAssertEqual(event.payload["message"]?.stringValue, "Hello")
    }

    func testActionResultKeepsAnExplicitNullValue() throws {
        guard case .actionResult(let result) = try StudioFrame.decode(text: try fixture("studio_action_result.json")) else {
            return XCTFail("not an action result")
        }
        XCTAssertEqual(result.value, .null)
        XCTAssertTrue(try result.encodedValueIsPresent())
    }

    func testPagedBodyAnchors() throws {
        guard case .body(let paged) = try StudioFrame.decode(text: try fixture("studio_body.paged.json")),
              case .body(let whole) = try StudioFrame.decode(text: try fixture("studio_body.json")) else {
            return XCTFail("not a body")
        }
        XCTAssertEqual(paged.anchor, .before("msg-0042"))
        XCTAssertEqual(paged.cursor, "msg-0012")
        XCTAssertEqual(paged.hasMore, true)
        XCTAssertNil(whole.anchor)

        let newest = #"{"type":"studio_body","tabId":"t","rows":[],"hasMore":false,"before":null}"#
        guard case .body(let newestPage) = try StudioFrame.decode(text: newest) else { return XCTFail("not a body") }
        XCTAssertEqual(newestPage.anchor, .newest)
        XCTAssertTrue(try newestPage.encodedText().contains(#""before":null"#))
    }

    func testWelcomeSkipsARelayEntryItCannotRead() throws {
        var welcome = try jsonObject(try fixture("studio_welcome.json")) as? [String: Any] ?? [:]
        welcome["pairedClientId"] = "phone-1"
        welcome["relays"] = [
            ["url": "wss://relay.example.org", "auth": ["mode": "psk", "key": "k"]],
            ["url": "wss://other.example.org", "auth": ["mode": "carrier-pigeon"]],
            ["url": "wss://oidc.example.org", "auth": ["mode": "relay-oidc"]],
            ["url": "wss://work.example.org", "auth": ["mode": "relay-oidc", "issuer": "https://login.example.org/work/v2.0", "clientId": "work-sign-in-app"]]
        ]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: welcome), as: UTF8.self)
        guard case .welcome(let decoded) = try StudioFrame.decode(text: text) else { return XCTFail("not a welcome") }
        XCTAssertEqual(decoded.pairedClientId, "phone-1")
        XCTAssertEqual(decoded.relays, [
            StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .psk(key: "k")),
            StudioEnvironmentRelay(url: "wss://oidc.example.org", auth: .relayOIDC(issuer: nil, clientId: nil)),
            StudioEnvironmentRelay(url: "wss://work.example.org", auth: .relayOIDC(issuer: "https://login.example.org/work/v2.0", clientId: "work-sign-in-app"))
        ])
        XCTAssertEqual(decoded.enterprisePolicy, .null)
    }

    /// The welcome is decoded by hand, so a property added to the struct is
    /// not enough: it needs a coding key and a line in `init(from:)`. Adding
    /// one without the other compiles, decodes as nil forever, and the field
    /// simply never arrives — which is what happened to `directAddresses`, so
    /// a phone paired over a relay kept being told where the server was and
    /// kept not hearing it.
    func testWelcomeCarriesTheServersDirectAddresses() throws {
        var welcome = try jsonObject(try fixture("studio_welcome.json")) as? [String: Any] ?? [:]
        welcome["pairedClientId"] = "phone-1"
        welcome["directAddresses"] = ["http://192.168.86.237:7331", "http://10.0.0.4:7331"]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: welcome), as: UTF8.self)
        guard case .welcome(let decoded) = try StudioFrame.decode(text: text) else { return XCTFail("not a welcome") }
        XCTAssertEqual(decoded.directAddresses, ["http://192.168.86.237:7331", "http://10.0.0.4:7331"])
        // Round-trips too: the key is on the encode side as well, so a frame
        // this client re-sends does not quietly drop it.
        let reencoded = String(decoding: try JSONEncoder().encode(decoded), as: UTF8.self)
        XCTAssertTrue(reencoded.contains("192.168.86.237"))
    }

    /// A server that predates the field sends none, and that is not an error.
    func testWelcomeWithoutDirectAddressesDecodes() throws {
        let welcome = try jsonObject(try fixture("studio_welcome.json")) as? [String: Any] ?? [:]
        let text = String(decoding: try JSONSerialization.data(withJSONObject: welcome), as: UTF8.self)
        guard case .welcome(let decoded) = try StudioFrame.decode(text: text) else { return XCTFail("not a welcome") }
        XCTAssertNil(decoded.directAddresses)
    }

    func testUnknownReasonsAreKeptNotRefused() throws {
        guard case .close(let close) = try StudioFrame.decode(text: #"{"type":"studio_close","reason":"moved_house"}"#),
              case .refused(let refused) = try StudioFrame.decode(text: #"{"type":"studio_refused","reason":"full_moon"}"#) else {
            return XCTFail("did not decode")
        }
        XCTAssertEqual(close.reason, .unknown("moved_house"))
        XCTAssertEqual(refused.reason, .unknown("full_moon"))
        XCTAssertFalse(refused.reason.isRetryable)
    }

    func testMalformedFramesThrow() {
        XCTAssertThrowsError(try StudioFrame.decode(text: "not json"))
        XCTAssertThrowsError(try StudioFrame.decode(text: "[]"))
        XCTAssertThrowsError(try StudioFrame.decode(text: #"{"type":"studio_teapot"}"#))
        XCTAssertThrowsError(try StudioFrame.decode(text: #"{"type":"studio_action","id":"a"}"#))
        XCTAssertThrowsError(try StudioFrame.decode(text: #"{"type":"studio_event","channel":"c"}"#))
        XCTAssertThrowsError(try StudioFrame.decode(text: #"{"type":"studio_snapshot","snapshot":[]}"#))
    }

    func testBinaryFrameLayout() throws {
        let frame = StudioBinaryFrame(channel: .terminalData, key: "tab-1:inst-1", payload: Data([0, 1, 2, 253, 254, 255]))
        let bytes = try frame.encoded()
        // The same bytes the TypeScript `encodeBinary` produced for the sealed fixture.
        XCTAssertEqual(bytes.base64EncodedString(), "AQAMdGFiLTE6aW5zdC0xAAEC/f7/")
        XCTAssertEqual(try StudioBinaryFrame.decode(bytes), frame)
        // A slice of a larger buffer decodes the same.
        let padded = Data([9, 9]) + bytes
        XCTAssertEqual(try StudioBinaryFrame.decode(padded.dropFirst(2)), frame)

        XCTAssertThrowsError(try StudioBinaryFrame.decode(Data([1, 0])))
        XCTAssertThrowsError(try StudioBinaryFrame.decode(Data([9, 0, 0])))
        XCTAssertThrowsError(try StudioBinaryFrame.decode(Data([1, 0, 5, 65])))
    }

    func testJSONValueKeepsWholeNumbersWhole() throws {
        let value = try JSONDecoder().decode(JSONValue.self, from: Data(#"{"a":200,"b":1.5,"c":true,"d":null,"e":["x"]}"#.utf8))
        XCTAssertEqual(value["a"], .int(200))
        XCTAssertEqual(value["b"], .double(1.5))
        XCTAssertEqual(value["c"], .bool(true))
        XCTAssertEqual(value["d"], .null)
        XCTAssertEqual(value["e"], .array([.string("x")]))
    }
}

private extension StudioActionResult {
    func encodedValueIsPresent() throws -> Bool {
        let object = try JSONSerialization.jsonObject(with: JSONEncoder().encode(self)) as? [String: Any]
        return object?["value"] is NSNull
    }
}

private extension StudioBody {
    func encodedText() throws -> String {
        try StudioFrame.body(self).encodedText()
    }
}

extension StudioFrameCodecTests {

    // MARK: - Which tenant a relay-oidc relay is joined from

    private var home: String { "https://login.example.org/home/v2.0" }
    private var work: String { "https://login.example.org/work/v2.0" }

    private var twoTenantConfig: Data {
        Data(#"""
        {"oidc":true,"psk":true,"issuer":"https://login.example.org/home/v2.0","audience":"home-app","requiredScope":"Relay.Access",
         "issuers":[{"issuer":"https://login.example.org/home/v2.0","audience":"home-app","requiredScope":"Relay.Access"},
                    {"issuer":"https://login.example.org/work/v2.0","audience":"work-app","requiredScope":"Relay.Access"}]}
        """#.utf8)
    }

    /// The relay binds a server's channel to the server's account, so the
    /// phone signs in to the tenant the server named, not the relay's first.
    func testTheServersTenantIsChosenFromTheRelaysIssuers() throws {
        let entries = RelayIssuerDirectory.parse(twoTenantConfig)
        XCTAssertEqual(entries.map(\.issuer), [home, work])
        let chosen = try RelayIssuerDirectory.choose(entries, serverIssuer: "\(work)/", relayURL: "wss://relay.example.org")
        XCTAssertEqual(chosen.issuer, work)
        XCTAssertEqual(chosen.audience, "work-app")
        XCTAssertEqual(chosen.scope, "api://work-app/Relay.Access")
    }

    func testAnUnnamedTenantIsRefusedWhenTheRelayOffersSeveral() {
        let entries = RelayIssuerDirectory.parse(twoTenantConfig)
        XCTAssertThrowsError(try RelayIssuerDirectory.choose(entries, serverIssuer: nil, relayURL: "wss://relay.example.org")) {
            XCTAssertEqual($0 as? RelayIssuerChoiceError, .serverTenantUnknown(relayURL: "wss://relay.example.org"))
        }
        XCTAssertThrowsError(try RelayIssuerDirectory.choose(entries, serverIssuer: "https://login.example.org/other/v2.0", relayURL: "wss://r")) {
            XCTAssertEqual($0 as? RelayIssuerChoiceError, .serverTenantNotAccepted(relayURL: "wss://r", issuer: "https://login.example.org/other/v2.0"))
        }
    }

    func testARelayWithOneIssuerNeedsNoChoiceAndItsConfigURLIsHTTPS() throws {
        let single = Data(#"{"oidc":true,"issuer":"https://login.example.org/home/v2.0","audience":"home-app","requiredScope":"api://home-app/Relay.Access"}"#.utf8)
        let chosen = try RelayIssuerDirectory.choose(RelayIssuerDirectory.parse(single), serverIssuer: nil, relayURL: "wss://r")
        XCTAssertEqual(chosen.scope, "api://home-app/Relay.Access")
        XCTAssertEqual(RelayIssuerDirectory.configURL(relayURL: "wss://relay.example.org"), URL(string: "https://relay.example.org/v1/auth/config"))
    }

    func testARelayOIDCEntryRoundTripsItsIssuerAndSignInApp() throws {
        let relay = StudioEnvironmentRelay(url: "wss://relay.example.org", auth: .relayOIDC(issuer: work, clientId: "work-sign-in-app"))
        let decoded = try JSONDecoder().decode(StudioEnvironmentRelay.self, from: try JSONEncoder().encode(relay))
        XCTAssertEqual(decoded, relay)
    }

    /// The relay's entry names only its own API app, which may accept no
    /// sign-in (Entra answers AADSTS500113). The phone signs in as the app
    /// the server named, and never trades a working saved app for the relay's.
    func testThePhoneSignsInAsTheServersAppNotTheRelays() throws {
        let entry = try RelayIssuerDirectory.choose(RelayIssuerDirectory.parse(twoTenantConfig), serverIssuer: work, relayURL: "wss://r")
        XCTAssertEqual(entry.signInClientId(serverClientId: "work-sign-in-app", storedIssuer: nil, storedClientId: nil), "work-sign-in-app")
        XCTAssertEqual(entry.signInClientId(serverClientId: "work-sign-in-app", storedIssuer: work, storedClientId: "old-app"), "work-sign-in-app")
        XCTAssertEqual(entry.signInClientId(serverClientId: nil, storedIssuer: work, storedClientId: "saved-app"), "saved-app")
        XCTAssertEqual(entry.signInClientId(serverClientId: "", storedIssuer: home, storedClientId: "home-sign-in-app"), "work-app")
        XCTAssertEqual(entry.signInClientId(serverClientId: nil, storedIssuer: nil, storedClientId: nil), "work-app")
    }

    // MARK: - Wire latency

    func testAPingDecodesAndItsAnswerCarriesTheSameNonce() throws {
        // The server times the round trip on ITS clock, so this client never
        // differences `t` against its own reading -- two machines' clocks
        // disagree, and avoiding that correction is the point of the measure.
        let text = #"{"type":"studio_ping","nonce":"abc123","t":1700000000000}"#
        guard case .ping(let ping) = try StudioFrame.decode(text: text) else {
            return XCTFail("a studio_ping did not decode as one")
        }
        XCTAssertEqual(ping.nonce, "abc123")

        let pong = StudioFrame.pong(StudioPing(nonce: ping.nonce, t: 1_700_000_000_042))
        let encoded = try JSONEncoder().encode(pong)
        let asJSON = try XCTUnwrap(try JSONSerialization.jsonObject(with: encoded) as? [String: Any])
        XCTAssertEqual(asJSON["type"] as? String, "studio_pong")
        XCTAssertEqual(asJSON["nonce"] as? String, "abc123")
    }

    func testThisClientAdvertisesThatItAnswersTheProbe() {
        // The server probes no connection without this capability: a frame an
        // older build could not decode would close its connection.
        let hello = StudioHello.thinMobile(clientId: "phone-1", credential: .paired(clientId: "phone-1", proof: "p"))
        XCTAssertTrue(hello.capabilities.contains(studioWirePingCapability))
    }

    func testTheClientWindowReportsPercentilesAndKeepsTimeoutsSeparate() {
        let latency = StudioClientLatency(transport: "mobile")
        let start = Date()
        for i in 1...10 {
            latency.noteActionSent(id: "a\(i)", at: start)
            latency.noteActionResult(id: "a\(i)", at: start.addingTimeInterval(Double(i) / 100))
        }
        // A timeout is a different event from a slow answer: counted, never
        // averaged in, where it would make the wire look merely sluggish.
        latency.noteActionSent(id: "gone", at: start)
        latency.noteActionTimeout(id: "gone")

        XCTAssertTrue(latency.hasSamples)
        XCTAssertEqual(StudioClientLatency.percentile([10, 20, 30, 40], 50), 20)
        XCTAssertEqual(StudioClientLatency.percentile([], 95), 0)
    }
}

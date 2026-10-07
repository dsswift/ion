import XCTest
@testable import IonRemote

/// Every action this phone sends is one client span: a prompt's is
/// `prompt.send`, every other's is `action.send` with the action's name, and
/// each closes with the server's answer.
final class ActionTraceBookTests: XCTestCase {

    private func book(_ written: Collected<TraceSpan.Record>) -> ActionTraceBook {
        ActionTraceBook { name, attributes, conversationId in
            TraceSpan(name: name, kind: .client, attributes: attributes, conversationId: conversationId) { written.append($0) }
        }
    }

    // MARK: - The book

    func testAPromptKeepsItsSpanNameAndClosesWithTheAnswer() {
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        _ = book.openPrompt(clientMsgId: "m-1", tabId: "t1", conversationId: "c1")
        XCTAssertNotNil(book.close(key: "m-1", accepted: false, error: "locked"))
        XCTAssertNil(book.close(key: "m-1", accepted: true, error: nil), "a span closes once")
        let record = written.values.first
        XCTAssertEqual(record?.name, "prompt.send")
        XCTAssertEqual(record?.error, "locked")
        XCTAssertEqual(record?.attributes["accepted"], "false")
        XCTAssertEqual(record?.attributes["action"], "session.prompt")
        XCTAssertEqual(record?.conversationId, "c1")
        XCTAssertEqual(record?.attributes["peer.service"], "ion-server", "the client span names its callee")
    }

    func testAnyOtherActionIsAnActionSendSpanNamedByItsAction() {
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        let span = book.openAction("tabs.close", key: "k-1", tabId: "t9")
        XCTAssertEqual(span.name, "action.send")
        XCTAssertNotNil(book.close(key: "k-1", accepted: true, error: nil))
        let record = written.values.first
        XCTAssertEqual(record?.name, "action.send")
        XCTAssertEqual(record?.attributes["action"], "tabs.close")
        XCTAssertEqual(record?.attributes["tab_id"], "t9")
        XCTAssertEqual(record?.attributes["accepted"], "true")
        XCTAssertNil(record?.error)
        XCTAssertEqual(book.openCount, 0)
    }

    func testTheSignedInIdentityIsStampedOnEverySpan() {
        TraceSpan.user = "josh@example.test"
        defer { TraceSpan.user = nil }
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        _ = book.openAction("tabs.create", key: "k", tabId: nil)
        book.close(key: "k", accepted: true, error: nil)
        XCTAssertEqual(written.values.first?.attributes["user"], "josh@example.test")
    }

    // MARK: - The transport

    func testEveryCommandLeavesWithATraceparentAndItsSpanClosesOnTheAnswer() async throws {
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        let connection = FakeStudioConnection()
        connection.answer("tabs.close", with: .failure(StudioActionFailure.refused(code: "forbidden", message: "no")))
        let transport = StudioTransport(deviceId: "device-1", connection: connection, traceBook: book)
        await transport.start()

        try await transport.send(.setDraft(tabId: "t1", text: "hi"))
        try await transport.send(.closeTab(tabId: "t2"))
        try await transport.send(.registerPush(token: "tok", env: "prod"))

        XCTAssertEqual(connection.submittedActions.map(\.action), ["setDraftInput", "tabs.close", "device.registerPush"])
        for traceparent in connection.submittedTraceparents {
            XCTAssertNotNil(TraceContext.parse(traceparent ?? ""), "every action carries a valid traceparent: \(String(describing: traceparent))")
        }
        XCTAssertEqual(written.values.map(\.name), ["action.send", "action.send", "action.send"])
        XCTAssertEqual(written.values.map { $0.attributes["action"] }, ["setDraftInput", "tabs.close", "device.registerPush"])
        XCTAssertEqual(written.values.map { $0.attributes["accepted"] }, ["true", "false", "true"])
        XCTAssertEqual(written.values[1].error, StudioActionFailure.refused(code: "forbidden", message: "no").localizedDescription)
        XCTAssertEqual(written.values[1].attributes["tab_id"], "t2", "the tab comes from the action's arguments")
        XCTAssertEqual(book.openCount, 0, "every span the transport opened is closed")
        // The traceparent on the wire is the span's own.
        for (record, traceparent) in zip(written.values, connection.submittedTraceparents) {
            XCTAssertEqual(TraceContext.parse(traceparent ?? "")?.spanId, record.spanId)
        }
        transport.stop()
    }

    func testAPromptKeepsTheViewModelsTraceAndMintsNoSecondSpan() async throws {
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        let connection = FakeStudioConnection()
        let transport = StudioTransport(deviceId: "device-1", connection: connection, traceBook: book)
        await transport.start()
        let traceparent = "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"

        try await transport.send(.prompt(tabId: "t1", text: "hi", clientMsgId: "m-1", traceparent: traceparent))

        XCTAssertEqual(connection.submittedTraceparents, [traceparent])
        XCTAssertEqual(written.values, [], "the prompt's span belongs to the view model's book")
        XCTAssertEqual(book.openCount, 0)
        transport.stop()
    }

    func testADirectCallAndAPagedActionAreTracedToo() async throws {
        let written = Collected<TraceSpan.Record>()
        let book = book(written)
        let connection = FakeStudioConnection()
        connection.answer("session.loadTranscript", with: .success(.object(["content": .string("all"), "hasMore": .bool(false)])))
        let transport = StudioTransport(deviceId: "device-1", connection: connection, traceBook: book)
        await transport.start()

        _ = try await transport.call("environment.server.info")
        try await transport.send(.requestTranscript(tabId: "t1", requestId: "r-1"))

        XCTAssertEqual(connection.submittedTraceparents.count, 2)
        XCTAssertTrue(connection.submittedTraceparents.allSatisfy { TraceContext.parse($0 ?? "") != nil })
        XCTAssertEqual(written.values.map { $0.attributes["action"] }, ["environment.server.info", "session.loadTranscript"])
        XCTAssertEqual(book.openCount, 0)
        transport.stop()
    }
}

import Foundation
import XCTest
@testable import IonRemote

final class RelayClientConnectTests: XCTestCase {
    func testConnectTimeoutCancelsTaskAndSchedulesReconnect() async {
        let task = TestRelayWebSocketTask()
        let factory = TestRelayWebSocketTaskFactory(task: task)
        let client = RelayClient(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "test-key",
            channelId: "ch123",
            connectDeadlineSeconds: 0.05,
            makeTaskFactory: { factory }
        )

        await client.connect()
        XCTAssertTrue(client.isConnecting)

        await waitUntil { task.cancelCount == 1 }

        XCTAssertFalse(client.isConnecting)
        XCTAssertFalse(client.isConnected)
        XCTAssertTrue(factory.didInvalidate)
        XCTAssertTrue(client.hasPendingReconnect)
        XCTAssertEqual(client.reconnectAttemptCount, 1)
        client.disconnect()
    }

    func testSecondConnectCancelsFirstTask() async {
        let firstTask = TestRelayWebSocketTask()
        let secondTask = TestRelayWebSocketTask()
        let factories = TestRelayWebSocketTaskFactoryQueue(tasks: [firstTask, secondTask])
        let client = RelayClient(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "test-key",
            channelId: "ch123",
            connectDeadlineSeconds: 5,
            makeTaskFactory: { factories.next() }
        )

        await client.connect()
        await client.connect()

        XCTAssertEqual(firstTask.cancelCount, 1)
        XCTAssertTrue(factories.factories[0].didInvalidate)
        XCTAssertEqual(secondTask.cancelCount, 0)
        XCTAssertTrue(client.isConnecting)
        client.disconnect()
    }

    func testFirstReceiveCancelsDeadlineAndResetsBackoff() async {
        let firstTask = TestRelayWebSocketTask()
        let secondTask = TestRelayWebSocketTask()
        let factories = TestRelayWebSocketTaskFactoryQueue(tasks: [firstTask, secondTask])
        let client = RelayClient(
            relayURL: URL(string: "wss://relay.example.com")!,
            apiKey: "test-key",
            channelId: "ch123",
            connectDeadlineSeconds: 0.05,
            makeTaskFactory: { factories.next() }
        )

        await client.connect()
        await waitUntil { client.reconnectAttemptCount == 1 }
        XCTAssertTrue(client.hasPendingReconnect)
        await client.connect()
        secondTask.completeReceive(.success(.data(Data("connected".utf8))))
        await waitUntil { client.isConnected }
        do {
            try await Task.sleep(for: .milliseconds(75))
        } catch {
            XCTFail("Unexpected test sleep cancellation: \(error)")
        }

        XCTAssertTrue(client.isConnected)
        XCTAssertFalse(client.isConnecting)
        XCTAssertEqual(firstTask.cancelCount, 1)
        XCTAssertEqual(secondTask.cancelCount, 0)
        XCTAssertEqual(client.reconnectAttemptCount, 0)
        XCTAssertFalse(client.hasPendingReconnect)
        client.disconnect()
    }

    private func waitUntil(
        timeout: Duration = .seconds(1),
        condition: @escaping () -> Bool
    ) async {
        let clock = ContinuousClock()
        let deadline = clock.now.advanced(by: timeout)
        while !condition(), clock.now < deadline {
            do {
                try await Task.sleep(for: .milliseconds(2))
            } catch {
                XCTFail("Unexpected wait cancellation: \(error)")
                return
            }
        }
        XCTAssertTrue(condition(), "condition did not become true before timeout")
    }
}

private final class TestRelayWebSocketTask: RelayWebSocketTasking, @unchecked Sendable {
    var state: URLSessionTask.State = .running
    var maximumMessageSize = 0
    var closeCode: URLSessionWebSocketTask.CloseCode = .invalid
    var response: URLResponse?
    private(set) var cancelCount = 0
    private var receiveHandler: (@Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void)?

    func resume() {}

    func cancel(with closeCode: URLSessionWebSocketTask.CloseCode, reason: Data?) {
        cancelCount += 1
        state = .canceling
    }

    func send(_ message: URLSessionWebSocketTask.Message) async throws {}

    func receive(
        completionHandler: @escaping @Sendable (Result<URLSessionWebSocketTask.Message, Error>) -> Void
    ) {
        receiveHandler = completionHandler
    }

    func sendPing(pongReceiveHandler: @escaping @Sendable (Error?) -> Void) {
        pongReceiveHandler(nil)
    }

    func completeReceive(_ result: Result<URLSessionWebSocketTask.Message, Error>) {
        let handler = receiveHandler
        receiveHandler = nil
        handler?(result)
    }
}

private final class TestRelayWebSocketTaskFactory: RelayWebSocketTaskFactory {
    let task: TestRelayWebSocketTask
    private(set) var didInvalidate = false

    init(task: TestRelayWebSocketTask) {
        self.task = task
    }

    func makeTask(request: URLRequest) -> RelayWebSocketTasking {
        task
    }

    func invalidateAndCancel() {
        didInvalidate = true
    }
}

private final class TestRelayWebSocketTaskFactoryQueue {
    private var tasks: [TestRelayWebSocketTask]
    private(set) var factories: [TestRelayWebSocketTaskFactory] = []

    init(tasks: [TestRelayWebSocketTask]) {
        self.tasks = tasks
    }

    func next() -> TestRelayWebSocketTaskFactory {
        let factory = TestRelayWebSocketTaskFactory(task: tasks.removeFirst())
        factories.append(factory)
        return factory
    }
}

import XCTest
@testable import IonRemote

/// Files under `packages/shared/src/studio-wire/__fixtures__`, read from the
/// repository this test file was compiled from.
enum StudioWireFixtures {
    static func directory(_ name: String, file: StaticString = #filePath) throws -> URL {
        var dir = URL(fileURLWithPath: "\(file)").deletingLastPathComponent()
        for _ in 0..<6 {
            let candidate = dir.appendingPathComponent("packages/shared/src/studio-wire/__fixtures__/\(name)")
            if FileManager.default.fileExists(atPath: candidate.path) { return candidate }
            dir = dir.deletingLastPathComponent()
        }
        throw XCTSkip("studio wire fixtures not found above \(file)")
    }
}

/// A thread-safe box for values a test collects from concurrent code.
final class Collected<Value: Sendable>: @unchecked Sendable {
    private let lock = NSLock()
    private var storage: [Value] = []

    func append(_ value: Value) { lock.withLock { storage.append(value) } }
    var values: [Value] { lock.withLock { storage } }
}

/// Polls `condition` until it holds or the timeout passes.
func waitUntil(
    _ description: String,
    timeout: Double = 2,
    file: StaticString = #filePath,
    line: UInt = #line,
    _ condition: @escaping () async -> Bool
) async {
    let deadline = Date().addingTimeInterval(timeout)
    while Date() < deadline {
        if await condition() { return }
        do {
            try await Task.sleep(for: .milliseconds(5))
        } catch {
            XCTFail("wait for '\(description)' was cancelled", file: file, line: line)
            return
        }
    }
    XCTFail("timed out waiting for: \(description)", file: file, line: line)
}

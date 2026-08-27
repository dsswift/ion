import CryptoKit
import XCTest
@testable import IonRemote

final class PayloadChunkAssemblerTests: XCTestCase {
    func testReassemblesExactBytesAndReleasesDeferredPayloadInOrder() throws {
        let payload = Data(#"{"type":"desktop_questions_state","tabId":"tab-1","state":{"workflows":[]}}"#.utf8)
        let later = Data(#"{"type":"desktop_heartbeat","ts":1,"buffered":0}"#.utf8)
        let chunks = makeChunks(payload, size: 17)
        let assembler = PayloadChunkAssembler()

        for chunk in chunks.dropLast() {
            XCTAssertEqual(assembler.accept(chunk), .held)
        }
        XCTAssertEqual(assembler.accept(later), .held)
        XCTAssertEqual(assembler.accept(try XCTUnwrap(chunks.last)), .assembled([payload, later]))
        XCTAssertFalse(assembler.hasPendingTransfer)
    }

    func testInterleavedTransfersPreserveLogicalOrder() {
        let first = Data(#"{"type":"desktop_questions_state","tabId":"first","state":{"workflows":[]}}"#.utf8)
        let second = Data(#"{"type":"desktop_questions_state","tabId":"second","state":{"workflows":[]}}"#.utf8)
        let firstChunks = makeChunks(first, size: 35, transferId: "first")
        let secondChunks = makeChunks(second, size: 35, transferId: "second")
        let assembler = PayloadChunkAssembler()

        XCTAssertEqual(assembler.accept(firstChunks[0]), .held)
        for chunk in secondChunks {
            XCTAssertEqual(assembler.accept(chunk), .held)
        }
        var result = PayloadChunkAssembler.Result.held
        for chunk in firstChunks.dropFirst() {
            result = assembler.accept(chunk)
        }
        XCTAssertEqual(result, .assembled([first, second]))
    }

    func testRejectsChangedMetadataAndClearsTransfer() throws {
        let payload = Data(#"{"type":"desktop_questions_state","tabId":"tab-1","state":{"workflows":[]}}"#.utf8)
        let chunks = makeChunks(payload, size: 20)
        let assembler = PayloadChunkAssembler()
        XCTAssertEqual(assembler.accept(chunks[0]), .held)

        var changed = try XCTUnwrap(JSONSerialization.jsonObject(with: chunks[1]) as? [String: Any])
        changed["totalBytes"] = payload.count + 1
        let changedData = try JSONSerialization.data(withJSONObject: changed)
        XCTAssertEqual(assembler.accept(changedData), .rejected)
        XCTAssertFalse(assembler.hasPendingTransfer)
    }

    func testRejectsHashAndOriginalTypeMismatch() {
        let payload = Data(#"{"type":"desktop_questions_state","tabId":"tab-1","state":{"workflows":[]}}"#.utf8)
        let assembler = PayloadChunkAssembler()

        let badHash = makeChunks(payload, size: payload.count, sha256: String(repeating: "0", count: 64))
        XCTAssertEqual(assembler.accept(badHash[0]), .rejected)

        let badType = makeChunks(payload, size: payload.count, originalType: "desktop_snapshot")
        XCTAssertEqual(assembler.accept(badType[0]), .rejected)
    }

    func testResetDropsPartialTransferAndDeferredPayloads() {
        let payload = Data(#"{"type":"desktop_questions_state","tabId":"tab-1","state":{"workflows":[]}}"#.utf8)
        let later = Data(#"{"type":"desktop_heartbeat","ts":1,"buffered":0}"#.utf8)
        let assembler = PayloadChunkAssembler()
        XCTAssertEqual(assembler.accept(makeChunks(payload, size: 20)[0]), .held)
        XCTAssertEqual(assembler.accept(later), .held)

        assembler.reset()

        XCTAssertFalse(assembler.hasPendingTransfer)
        XCTAssertEqual(assembler.accept(later), .passthrough(later))
    }

    func testResendUnavailableClearsPartialTransferAndPassesThrough() {
        let payload = Data(#"{"type":"desktop_questions_state","tabId":"tab-1","state":{"workflows":[]}}"#.utf8)
        let unavailable = Data(#"{"type":"desktop_resend_unavailable","fromSeq":2}"#.utf8)
        let assembler = PayloadChunkAssembler()
        XCTAssertEqual(assembler.accept(makeChunks(payload, size: 20)[0]), .held)

        XCTAssertEqual(assembler.accept(unavailable), .passthrough(unavailable))
        XCTAssertFalse(assembler.hasPendingTransfer)
    }

    private func makeChunks(
        _ payload: Data,
        size: Int,
        transferId: String = "transfer-1",
        originalType: String = "desktop_questions_state",
        sha256: String? = nil
    ) -> [Data] {
        let digest = sha256 ?? SHA256.hash(data: payload).map { String(format: "%02x", $0) }.joined()
        let count = Int(ceil(Double(payload.count) / Double(size)))
        return (0..<count).map { index in
            let start = index * size
            let end = min(start + size, payload.count)
            let chunk = payload.subdata(in: start..<end)
            let object: [String: Any] = [
                "type": PayloadChunk.type,
                "transferId": transferId,
                "index": index,
                "count": count,
                "originalType": originalType,
                "totalBytes": payload.count,
                "sha256": digest,
                "data": chunk.base64EncodedString()
            ]
            return try! JSONSerialization.data(withJSONObject: object)
        }
    }
}

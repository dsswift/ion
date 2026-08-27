import CryptoKit
import Foundation

/// Reassembles transport-only payload chunks without exposing partial JSON.
final class PayloadChunkAssembler {
    enum Result: Equatable {
        case passthrough(Data)
        case held
        case assembled([Data])
        case rejected
    }

    private struct Transfer {
        let count: Int
        let originalType: String
        let totalBytes: Int
        let sha256: String
        var chunks: [Int: Data]
    }

    private enum PendingItem {
        case transfer(String)
        case payload(Data)
    }

    private var transfers: [String: Transfer] = [:]
    private var completedTransfers: [String: Data] = [:]
    private var pendingItems: [PendingItem] = []

    var hasPendingTransfer: Bool { !transfers.isEmpty || !completedTransfers.isEmpty }

    /// Accept one decrypted and decompressed payload. A normal event passes
    /// through unless an older fragmented event is incomplete. In that case it
    /// waits so consumers never observe later logical events first.
    func accept(_ payload: Data) -> Result {
        guard Self.payloadType(payload) == PayloadChunk.type else {
            if Self.payloadType(payload) == "desktop_resend_unavailable" {
                reset()
                return .passthrough(payload)
            }
            if pendingItems.isEmpty { return .passthrough(payload) }
            pendingItems.append(.payload(payload))
            return flushReady()
        }

        guard let chunk = try? JSONDecoder().decode(PayloadChunk.self, from: payload) else {
            reset()
            return .rejected
        }
        return accept(chunk)
    }

    func reset() {
        transfers.removeAll()
        completedTransfers.removeAll()
        pendingItems.removeAll()
    }

    private func accept(_ chunk: PayloadChunk) -> Result {
        guard !chunk.transferId.isEmpty,
              chunk.index >= 0,
              chunk.count > 0,
              chunk.index < chunk.count,
              !chunk.originalType.isEmpty,
              chunk.originalType != PayloadChunk.type,
              chunk.totalBytes >= 0,
              chunk.sha256.count == 64,
              let bytes = Data(base64Encoded: chunk.data) else {
            reset()
            return .rejected
        }

        if let existing = transfers[chunk.transferId],
           existing.count != chunk.count ||
           existing.originalType != chunk.originalType ||
           existing.totalBytes != chunk.totalBytes ||
           existing.sha256 != chunk.sha256 {
            reset()
            return .rejected
        }

        if transfers[chunk.transferId] == nil {
            transfers[chunk.transferId] = Transfer(
                count: chunk.count,
                originalType: chunk.originalType,
                totalBytes: chunk.totalBytes,
                sha256: chunk.sha256,
                chunks: [:]
            )
            pendingItems.append(.transfer(chunk.transferId))
        }

        guard var transfer = transfers[chunk.transferId] else {
            reset()
            return .rejected
        }
        if let existingChunk = transfer.chunks[chunk.index], existingChunk != bytes {
            reset()
            return .rejected
        }
        transfer.chunks[chunk.index] = bytes
        transfers[chunk.transferId] = transfer
        if transfer.chunks.count == transfer.count {
            guard let payload = assemble(transfer) else {
                reset()
                return .rejected
            }
            completedTransfers[chunk.transferId] = payload
            transfers.removeValue(forKey: chunk.transferId)
        }
        return flushReady()
    }

    private func flushReady() -> Result {
        var payloads: [Data] = []
        while let first = pendingItems.first {
            switch first {
            case .payload(let payload):
                payloads.append(payload)
                pendingItems.removeFirst()
            case .transfer(let id):
                guard let payload = completedTransfers[id] else {
                    return payloads.isEmpty ? .held : .assembled(payloads)
                }
                payloads.append(payload)
                completedTransfers.removeValue(forKey: id)
                pendingItems.removeFirst()
            }
        }
        return payloads.isEmpty ? .held : .assembled(payloads)
    }

    private func assemble(_ transfer: Transfer) -> Data? {
        var payload = Data()
        payload.reserveCapacity(transfer.totalBytes)
        for index in 0..<transfer.count {
            guard let part = transfer.chunks[index] else { return nil }
            payload.append(part)
        }
        guard payload.count == transfer.totalBytes,
              Self.hexDigest(payload) == transfer.sha256.lowercased(),
              Self.payloadType(payload) == transfer.originalType else {
            return nil
        }
        return payload
    }

    private static func hexDigest(_ data: Data) -> String {
        SHA256.hash(data: data).map { String(format: "%02x", $0) }.joined()
    }

    private static func payloadType(_ data: Data) -> String? {
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
            return nil
        }
        return object["type"] as? String
    }
}

/// A transport-only fragment of one encoded desktop event payload.
struct PayloadChunk: Decodable {
    static let type = "desktop_payload_chunk"

    let transferId: String
    let index: Int
    let count: Int
    let originalType: String
    let totalBytes: Int
    let sha256: String
    let data: String
}

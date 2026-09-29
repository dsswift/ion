import Foundation

/// One binary frame of the Studio wire:
/// `[1 byte channel][2 bytes key length, big endian][UTF-8 key][payload]`.
/// The payload is raw bytes, never base64 (`studio-wire/codec.ts`).
struct StudioBinaryFrame: Equatable, Sendable {

    /// The 1-byte channel header (`studio-wire/channels.ts` `BinaryChannel`).
    enum Channel: UInt8, Sendable {
        case terminalData = 0x01
        case terminalResize = 0x02
        case fileChunk = 0x03
    }

    let channel: Channel
    /// The terminal identity (`tabId:instanceId`), or a transfer id for a file chunk.
    let key: String
    let payload: Data

    func encoded() throws -> Data {
        let keyBytes = Data(key.utf8)
        guard keyBytes.count <= 0xffff else {
            throw StudioWireError(message: "studio wire binary key too long: \(keyBytes.count) bytes")
        }
        var out = Data(capacity: 3 + keyBytes.count + payload.count)
        out.append(channel.rawValue)
        out.append(UInt8((keyBytes.count >> 8) & 0xff))
        out.append(UInt8(keyBytes.count & 0xff))
        out.append(keyBytes)
        out.append(payload)
        return out
    }

    static func decode(_ data: Data) throws -> StudioBinaryFrame {
        // Rebase so a slice of a larger buffer indexes from zero.
        let bytes = Data(data)
        guard bytes.count >= 3 else {
            throw StudioWireError(message: "studio wire binary frame shorter than the 3-byte header")
        }
        guard let channel = Channel(rawValue: bytes[0]) else {
            throw StudioWireError(message: "studio wire binary frame has unknown channel: \(bytes[0])")
        }
        let keyLength = (Int(bytes[1]) << 8) | Int(bytes[2])
        guard bytes.count >= 3 + keyLength else {
            throw StudioWireError(message: "studio wire binary frame shorter than its declared key length")
        }
        guard let key = String(data: bytes.subdata(in: 3..<(3 + keyLength)), encoding: .utf8) else {
            throw StudioWireError(message: "studio wire binary frame key is not UTF-8")
        }
        return StudioBinaryFrame(channel: channel, key: key, payload: bytes.subdata(in: (3 + keyLength)..<bytes.count))
    }
}

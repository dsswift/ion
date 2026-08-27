import Compression
import Foundation

/// Decompresses raw DEFLATE data (no gzip/zlib header) using Apple's Compression framework.
///
/// The desktop compresses outbound payloads with `zlib.deflateRawSync()` (raw DEFLATE)
/// and prepends a 0x01 version byte. After decryption, callers strip the version byte
/// and pass the remaining data here.
///
/// `COMPRESSION_ZLIB` in Apple's Compression framework handles raw DEFLATE (RFC 1951),
/// which is exactly what Node.js `deflateRawSync` produces.
enum PayloadCompression {
    /// The desktop sends smaller JSON payloads without compression. This avoids
    /// DEFLATE overhead on frequent text deltas while preserving the legacy form.
    private static let compressionFloorBytes = 512
    private static let compressedPrefix: UInt8 = 0x01

    /// Prepare an outbound JSON payload for encryption.
    ///
    /// Payloads at or above the shared compression floor are encoded as a 0x01
    /// version byte followed by raw DEFLATE. Smaller payloads stay unchanged;
    /// their JSON first byte cannot conflict with the version byte.
    static func prepareOutbound(_ data: Data) throws -> Data {
        guard data.count >= compressionFloorBytes else {
            return data
        }

        var prepared = Data([compressedPrefix])
        prepared.append(try deflateRaw(data))
        DiagnosticLog.trace("payload compressed", tag: "payload.compression", fields: [
            "input_bytes": String(data.count),
            "output_bytes": String(prepared.count)
        ])
        return prepared
    }

    /// Compress raw DEFLATE data (no gzip/zlib header).
    private static func deflateRaw(_ data: Data) throws -> Data {
        try processRawDeflate(data, operation: COMPRESSION_STREAM_ENCODE)
    }

    /// Decompress raw DEFLATE data. Throws on failure.
    ///
    /// Uses a streaming decode loop (`compression_stream`) that grows the output by
    /// appending fixed-size chunks until the framework reports `COMPRESSION_STATUS_END`.
    /// This never truncates: unlike a fixed-multiplier buffer, the loop keeps allocating
    /// chunks until the decompressor drains the entire input. A payload that compresses
    /// 100:1 decodes just as completely as one that compresses 2:1.
    static func inflateRaw(_ data: Data) throws -> Data {
        let output = try processRawDeflate(data, operation: COMPRESSION_STREAM_DECODE)

        // Surface size anomalies in ios-diagnostic-logs.jsonl. A wildly off ratio here
        // (or a size that lands on a suspicious power-of-two multiple) is the fingerprint
        // of a decode problem — logging every success makes it observable.
        DiagnosticLog.trace("payload decompressed", tag: "payload.compression", fields: [
            "input_bytes": String(data.count),
            "output_bytes": String(output.count)
        ])

        return output
    }

    /// Stream raw DEFLATE through Apple's Compression framework without a fixed
    /// output limit. `COMPRESSION_ZLIB` maps to RFC 1951 raw DEFLATE, matching
    /// Node.js `zlib.deflateRawSync()` on the desktop transport.
    private static func processRawDeflate(
        _ data: Data,
        operation: compression_stream_operation
    ) throws -> Data {
        let inputCount = data.count
        guard inputCount > 0 else {
            throw CompressionError.emptyInput
        }

        // Allocate the stream state. `compression_stream_init` initializes the struct;
        // the value copied out of freshly-allocated memory is overwritten by init.
        let streamPointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPointer.deallocate() }
        var stream = streamPointer.pointee

        guard compression_stream_init(&stream, operation, COMPRESSION_ZLIB)
            == COMPRESSION_STATUS_OK else {
            throw CompressionError.compressionFailed
        }
        defer { compression_stream_destroy(&stream) }

        // Per-iteration output chunk. Start with 8× the input size (DEFLATE typically
        // compresses JSON 10–15×) but never below 64 KiB, so tiny inputs still get a
        // reasonable working buffer and large ones minimize loop iterations.
        let chunkCapacity = max(inputCount * 8, 65_536)
        let chunk = UnsafeMutablePointer<UInt8>.allocate(capacity: chunkCapacity)
        defer { chunk.deallocate() }

        var output = Data()

        try data.withUnsafeBytes { (inputPtr: UnsafeRawBufferPointer) in
            guard let inputBase = inputPtr.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                throw CompressionError.emptyInput
            }

            // Point the stream at the full input once. FINALIZE tells the framework
            // this is the complete source, so it emits all remaining output across
            // successive process() calls even when a single chunk can't hold it.
            stream.src_ptr = inputBase
            stream.src_size = inputCount

            let finalizeFlag = Int32(COMPRESSION_STREAM_FINALIZE.rawValue)

            while true {
                stream.dst_ptr = chunk
                stream.dst_size = chunkCapacity

                let status = compression_stream_process(&stream, finalizeFlag)
                let produced = chunkCapacity - stream.dst_size

                switch status {
                case COMPRESSION_STATUS_OK:
                    // Chunk filled but more output remains. Append and loop for another.
                    if produced > 0 {
                        output.append(chunk, count: produced)
                    }
                case COMPRESSION_STATUS_END:
                    // All output produced. Append the final bytes and stop.
                    if produced > 0 {
                        output.append(chunk, count: produced)
                    }
                    return
                default:
                    throw CompressionError.compressionFailed
                }
            }
        }

        return output
    }

    enum CompressionError: Error, CustomStringConvertible {
        case emptyInput
        case bufferAllocationFailed
        case compressionFailed

        var description: String {
            switch self {
            case .emptyInput: return "PayloadCompression: empty input data"
            case .bufferAllocationFailed: return "PayloadCompression: failed to allocate output buffer"
            case .compressionFailed: return "PayloadCompression: COMPRESSION_ZLIB stream processing failed"
            }
        }
    }
}

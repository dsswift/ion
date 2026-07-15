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

    /// Decompress raw DEFLATE data. Throws on failure.
    ///
    /// Uses a streaming decode loop (`compression_stream`) that grows the output by
    /// appending fixed-size chunks until the framework reports `COMPRESSION_STATUS_END`.
    /// This never truncates: unlike a fixed-multiplier buffer, the loop keeps allocating
    /// chunks until the decompressor drains the entire input. A payload that compresses
    /// 100:1 decodes just as completely as one that compresses 2:1.
    static func inflateRaw(_ data: Data) throws -> Data {
        let inputCount = data.count
        guard inputCount > 0 else {
            throw CompressionError.emptyInput
        }

        // Allocate the stream state. `compression_stream_init` initializes the struct;
        // the value copied out of freshly-allocated memory is overwritten by init.
        let streamPointer = UnsafeMutablePointer<compression_stream>.allocate(capacity: 1)
        defer { streamPointer.deallocate() }
        var stream = streamPointer.pointee

        guard compression_stream_init(&stream, COMPRESSION_STREAM_DECODE, COMPRESSION_ZLIB)
            == COMPRESSION_STATUS_OK else {
            throw CompressionError.decompressionFailed
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
                    throw CompressionError.decompressionFailed
                }
            }
        }

        // Surface size anomalies in ios-diagnostic-logs.jsonl. A wildly off ratio here
        // (or a size that lands on a suspicious power-of-two multiple) is the fingerprint
        // of a decode problem — logging every success makes it observable.
        DiagnosticLog.trace("payload decompressed", tag: "payload.compression", fields: [
            "input_bytes": String(inputCount),
            "output_bytes": String(output.count)
        ])

        return output
    }

    enum CompressionError: Error, CustomStringConvertible {
        case emptyInput
        case bufferAllocationFailed
        case decompressionFailed

        var description: String {
            switch self {
            case .emptyInput: return "PayloadCompression: empty input data"
            case .bufferAllocationFailed: return "PayloadCompression: failed to allocate output buffer"
            case .decompressionFailed: return "PayloadCompression: COMPRESSION_ZLIB decompression returned 0"
            }
        }
    }
}

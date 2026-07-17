import Compression
import XCTest
@testable import IonRemote

/// Regression test for the 30s-latency bug: `PayloadCompression.inflateRaw`
/// silently truncated any payload that compressed better than 32:1.
///
/// The old implementation allocated a fixed `inputCount * 8` output buffer and
/// retried once at `inputCount * 32`. A payload that decompressed to more than
/// 32× its compressed size overran the retry buffer, and `compression_decode_buffer`
/// returned that buffer full — truncated, with no error. JSONDecoder then failed
/// on the truncated bytes, the event was dropped, and the desktop resent after a
/// 30s timeout.
///
/// The streaming-loop rewrite (`compression_stream` + FINALIZE) drains the entire
/// input regardless of ratio, so no truncation is possible. This test builds a
/// highly repetitive payload that compresses far past 32:1 and asserts a
/// byte-for-byte round-trip. On the unfixed code the assertion fails because the
/// returned data is truncated to the 32× cap.
final class PayloadCompressionTests: XCTestCase {

    /// Round-trip a payload that compresses better than 32:1.
    ///
    /// ~120,000 bytes of repetitive JSON-like text compresses to well under 3,750
    /// bytes (32:1). Old code: buffers at most ~32× the compressed size, returns
    /// truncated output ≠ original. New code: loops until COMPRESSION_STATUS_END,
    /// returns the full original.
    func testInflateRawDoesNotTruncateHighlyCompressiblePayload() throws {
        let original = String(
            repeating: "AAAA{\"key\":\"value\",\"field\":123}",
            count: 4000
        ).data(using: .utf8)!

        let compressed = try Self.deflateRaw(original)

        // Sanity: the payload must actually compress better than 32:1, otherwise
        // this test would pass on the buggy code and prove nothing.
        XCTAssertLessThan(
            compressed.count * 32, original.count,
            "test payload must compress better than 32:1 to exercise the truncation bug"
        )

        let result = try PayloadCompression.inflateRaw(compressed)

        XCTAssertEqual(result, original, "decompressed output must match the original byte-for-byte")
    }

    /// Compress with raw DEFLATE via `compression_encode_buffer` (COMPRESSION_ZLIB),
    /// matching the algorithm the desktop uses (`zlib.deflateRawSync`).
    private static func deflateRaw(_ data: Data) throws -> Data {
        let sourceCount = data.count
        // Compressed output is smaller than the source for this payload; a buffer
        // the size of the source is always sufficient headroom.
        let destCapacity = max(sourceCount, 64)
        let dest = UnsafeMutablePointer<UInt8>.allocate(capacity: destCapacity)
        defer { dest.deallocate() }

        let written: Int = data.withUnsafeBytes { (src: UnsafeRawBufferPointer) in
            guard let srcBase = src.baseAddress?.assumingMemoryBound(to: UInt8.self) else {
                return 0
            }
            return compression_encode_buffer(
                dest, destCapacity,
                srcBase, sourceCount,
                nil,
                COMPRESSION_ZLIB
            )
        }

        guard written > 0 else {
            throw PayloadCompression.CompressionError.decompressionFailed
        }
        return Data(bytes: dest, count: written)
    }
}

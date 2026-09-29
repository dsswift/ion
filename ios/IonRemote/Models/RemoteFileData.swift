import Foundation

/// A file's bytes, sent as base64 (`fs.readFileData`).
struct RemoteFileData: Decodable, Sendable {
    let base64: String
    let size: Int
}

import Foundation

/// A clicked file path, resolved on the server that owns the conversation
/// (`fs.resolveLink`): `~/` against that machine's home, a relative path
/// against the conversation's working directory.
struct FileLinkTarget: Decodable, Equatable, Sendable {
    let path: String
    let exists: Bool
    let isDirectory: Bool
    let size: Int
}

import Foundation

/// One revision of a transcript stream: the stream's epoch and a revision
/// number within it. A newest-page request names the revision the phone
/// holds, so the server can say it is still current.
struct TranscriptRevision: Codable, Equatable, Sendable {
    var epoch: String
    var rev: Int
}

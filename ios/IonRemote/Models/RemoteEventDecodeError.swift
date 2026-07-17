import Foundation

/// Typed errors from the RemoteEvent decoder.
///
/// Separates "wire type string has no TypeKey case" (expected, forward-compat)
/// from a genuine DecodingError (known type, bad payload — always a bug).
/// TransportManager+Receive.swift catches this error before the general catch
/// so the two categories get different handling: unknown types are dropped at
/// trace level with no resync; bad payloads log at error level and trigger a
/// full resync.
enum RemoteEventDecodeError: Error {
    /// A wire event arrived with a type string that has no TypeKey case.
    /// This is expected for engine event types iOS has not yet wired up
    /// (e.g. desktop_compacting, desktop_extension_died). Not data loss —
    /// the desktop forwards every engine event; iOS skips the ones it has
    /// no decoder for. Callers should drop gracefully at trace level with
    /// no resync.
    case unknownType(String)
}

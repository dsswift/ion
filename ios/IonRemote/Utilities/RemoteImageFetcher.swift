import UIKit

/// Coordinates lazy fetches of image bytes from the desktop.
///
/// `EngineMessageRow` renders inline images by parsing `[Attached image: PATH]`
/// markers in the message body and looking up bytes in `AttachmentImageCache`
/// by path. After an iOS reinstall the local cache is empty, so the lookup
/// misses. Calling `request(path:viewModel:completion:)` sends `fs_read_image`
/// to the desktop, populates the cache when the response arrives, and notifies
/// every observer registered for that path. Multiple concurrent observers for
/// the same path coalesce into a single network round-trip.
@MainActor
final class RemoteImageFetcher {
    static let shared = RemoteImageFetcher()

    private var pending: [String: [(UIImage?) -> Void]] = [:]
    private var failed: Set<String> = []
    private var failureReasons: [String: String] = [:]

    private init() {}

    /// Look up `path` in the local cache; on a miss, request bytes from the
    /// desktop. The completion fires once with the resolved image (or nil if
    /// the desktop rejected the path). Already-fetched paths short-circuit.
    func request(path: String, viewModel: SessionViewModel, completion: @escaping (UIImage?) -> Void) {
        if let img = AttachmentImageCache.shared.image(forKey: path) {
            completion(img)
            return
        }
        if failed.contains(path) {
            completion(nil)
            return
        }
        if pending[path] != nil {
            // RC-20: an existing pending list means a request is in flight. But a
            // request whose fs_image_content response never arrived (transport
            // switch / disconnect mid-flight) would ORPHAN this list forever, and
            // every later request appended to it and never re-sent — the image
            // stuck on the placeholder for the process lifetime. Re-send the fetch
            // so an orphaned pending path self-heals; the desktop dedupes and
            // deliver() fans out to all queued observers. Duplicate in-flight
            // sends are harmless (fire-and-forget, idempotent read).
            pending[path]?.append(completion)
            viewModel.send(.fsReadImage(filePath: path), intent: .automaticFireAndForget)
            return
        }
        pending[path] = [completion]
        viewModel.send(.fsReadImage(filePath: path), intent: .automaticFireAndForget) // re-fires on next render if disconnected
    }

    /// Called by the event handler when `fs_image_content` arrives. `error`
    /// is the reason the desktop gave for sending no image.
    func deliver(path: String, dataUrl: String?, error: String? = nil) {
        let observers = pending.removeValue(forKey: path) ?? []
        guard let dataUrl, let bytes = decodeDataUrl(dataUrl) else {
            // RC-20: do NOT permanently blacklist. A nil deliver is frequently
            // transient (the desktop dropped the response on a transport switch),
            // not a genuine "path does not exist". Notify current observers with
            // nil (they render the placeholder for now) but leave `failed` clear
            // so the next render's request retries. A genuinely missing path
            // simply retries cheaply on re-render rather than sticking forever.
            failureReasons[path] = error
            for cb in observers { cb(nil) }
            return
        }
        failed.remove(path)
        AttachmentImageCache.shared.store(data: bytes, forKey: path)
        let image = UIImage(data: bytes)
        failureReasons[path] = image == nil ? "Unsupported image format" : nil
        for cb in observers { cb(image) }
    }

    /// Why the last fetch of `path` produced no image, when a reason is known.
    func failureReason(for path: String) -> String? {
        failureReasons[path]
    }

    /// Ask again for every fetch still waiting, on a transport reconnect. A
    /// request made while disconnected was never sent, and one in flight when
    /// the connection dropped will never be answered; the observers of both
    /// are still waiting and get their image from this resend.
    func retryPending(viewModel: SessionViewModel) {
        failed.removeAll()
        failureReasons.removeAll()
        for path in pending.keys {
            viewModel.send(.fsReadImage(filePath: path), intent: .automaticFireAndForget)
        }
        if !pending.isEmpty {
            DiagnosticLog.log("image fetches resent on reconnect", tag: "image.fetcher", fields: [
                "count": String(pending.count)
            ])
        }
    }

    /// Forget all fetch state on unpair, alongside AttachmentImageCache.clearAll().
    func resetTransientState() {
        failed.removeAll()
        pending.removeAll()
        failureReasons.removeAll()
    }

    private func decodeDataUrl(_ s: String) -> Data? {
        guard let comma = s.firstIndex(of: ",") else { return nil }
        let base64 = String(s[s.index(after: comma)...])
        return Data(base64Encoded: base64)
    }
}

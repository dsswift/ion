import Foundation

// MARK: - Incremental export (the desktop's log pull)

extension DiagnosticLog {

    /// One incremental pull's result. See `exportIncrementalSince`.
    struct IncrementalExport: Sendable {
        /// New JSONL lines, newline-terminated; empty when nothing shipped.
        let logs: String
        /// Resume cursor the puller persists and echoes back as `sinceSeq`.
        let nextSeq: Int
        /// Newer lines kept back because they carry no `pairing_id`.
        let withheldUnstamped: Int
        /// Newer lines kept back because they belong to a different pairing.
        let withheldOtherPairing: Int
    }

    /// Return all retained log lines whose `fields.seq` is strictly greater
    /// than `sinceSeq`. Used by the desktop's incremental log pull so repeated
    /// pulls transfer only new lines and never re-ship history already
    /// persisted.
    ///
    /// Returns an `IncrementalExport`: `logs` is the new JSONL lines and
    /// `nextSeq` is the resume cursor — the highest seq this pull PASSED
    /// OVER, shipped or withheld, or the input floor when nothing is newer.
    /// It is deliberately not "the highest seq shipped": a filtered pull must
    /// not rewind over lines it has already decided to keep back, or every
    /// later pull would re-examine them forever. `withheldUnstamped` / `withheldOtherPairing`
    /// count the newer lines the pairing filter kept back, so the puller can
    /// tell "nothing new" apart from "lines exist and none were sent".
    /// The desktop persists `nextSeq` and echoes it back as the next pull's
    /// `sinceSeq`; its dedup also drops any line with `seq <= mark`. The
    /// cursor must therefore be the highest seq ALREADY SHIPPED — reporting
    /// `maxSeq + 1` (the previous behavior) made both the iOS strict-greater
    /// filter and the desktop dedup skip the line later stamped exactly
    /// `maxSeq + 1`, silently losing one line per non-empty pull cycle.
    ///
    /// Seq-based rather than line-count-based: a line count is invalidated the
    /// moment an on-device session file rotates out (the Nth line no longer
    /// addresses the same logical entry), whereas `seq` is a monotonic per-line
    /// identity independent of file layout. Lines with no parseable `seq` (only
    /// possible from a pre-upgrade retained session) are treated as already-seen
    /// and skipped, so a mixed-schema history never re-ships.
    ///
    /// **Async + cursor-based.** The read/split/parse work runs on `writeQueue`
    /// (never the main actor — the previous main-thread full-history rescan of
    /// up to 10 MB every 5 s was watchdog-kill territory), and a per-file byte
    /// cursor means each pull reads only the tail written since the last pull.
    /// A rotated-in file with no cursor entry is read from 0. A request whose
    /// `sinceSeq` precedes what the cursor already skipped (desktop reset /
    /// seq regression) resets the cursor and rescans everything, so
    /// correctness never depends on the cursor. Output format is byte-identical
    /// to the pre-cursor implementation (the desktop parses it).
    static func exportIncrementalSince(sinceSeq: Int, pairingId: String? = nil) async -> IncrementalExport {
        await withCheckedContinuation { continuation in
            shared.writeQueue.async {
                continuation.resume(returning: shared._exportIncrementalOnQueue(sinceSeq: sinceSeq, pairingId: pairingId))
            }
        }
    }

    /// writeQueue-confined incremental export. See `exportIncrementalSince`.
    /// When `pairingId` is non-nil, only lines stamped with that pairing are
    /// returned. A line with no pairing_id was written while no pairing was
    /// selected, so it belongs to no desktop and is excluded from filtered
    /// exports. The seq cursor advances over ALL lines (including filtered-out
    /// ones) so it remains globally monotonic; every line it passes over
    /// without shipping is counted in the result, never dropped unseen.
    ///
    /// The server asks from a seq it has already saved, so `sinceSeq` also
    /// confirms delivery for `pairingId`, which lets retention delete those
    /// lines. A `sinceSeq` above anything this device has written comes from
    /// an older seq space (a reinstall): it confirms nothing, and the pull
    /// starts from 0 so the server sees its cursor regress and resets.
    private func _exportIncrementalOnQueue(sinceSeq requestedSince: Int, pairingId: String? = nil) -> IncrementalExport {
        let highestWritten = _highestWrittenSeqOnQueue()
        var sinceSeq = requestedSince
        if requestedSince > highestWritten {
            sinceSeq = 0
            DiagnosticLog.log("diagnostic export: puller cursor ahead of device", tag: "diagnostics", level: .warn, fields: [
                "since_seq": String(requestedSince),
                "highest_seq": String(highestWritten),
                "pairing_id": pairingId ?? ""
            ])
        } else if let pairingId {
            _recordShippedOnQueue(pairingId: pairingId, throughSeq: requestedSince)
        }

        // Cursor validity: the cursor skips bytes whose lines were already
        // scanned; every skipped line has seq ≤ exportScannedMaxSeq. A skipped
        // line qualifies for this pull only when its seq > sinceSeq, so the
        // cursor is sound iff sinceSeq ≥ exportScannedMaxSeq. When the desktop
        // asks from an older position (fresh desktop, cursor file loss, seq
        // regression), reset and rescan from 0 — correctness never depends on
        // the cursor.
        if sinceSeq < exportScannedMaxSeq {
            exportFileOffsets.removeAll()
            exportScannedMaxSeq = 0
        }

        let fm = FileManager.default
        var liveNames = allLogFiles()
        liveNames.append(Self.currentLogName)

        // Drop cursor entries for files pruned/rotated away so the map never
        // grows unbounded across long-running sessions.
        let liveSet = Set(liveNames)
        exportFileOffsets = exportFileOffsets.filter { liveSet.contains($0.key) }

        var newLines: [String] = []
        var maxSeq = sinceSeq
        var withheldUnstamped = 0
        var withheldOtherPairing = 0

        for name in liveNames {
            let url = logDirectory.appendingPathComponent(name)
            guard fm.fileExists(atPath: url.path) else { continue }
            let handle: FileHandle
            do {
                handle = try FileHandle(forReadingFrom: url)
            } catch {
                DiagnosticLog.log("log export open failed", tag: "diagnostics", level: .warn, fields: [
                    "file": name,
                    "error": error.localizedDescription
                ])
                continue
            }
            // Closing a read-only handle loses nothing; the export already has its bytes.
            // swiftlint:disable:next silent_try_optional
            defer { try? handle.close() }

            let start = exportFileOffsets[name] ?? 0
            let end: UInt64
            let read: Data?
            do {
                end = try handle.seekToEnd()
                guard end > start else { continue } // nothing new in this file
                try handle.seek(toOffset: start)
                read = try handle.read(upToCount: Int(end - start))
            } catch {
                // The cursor is not advanced, so the next pull retries these bytes.
                DiagnosticLog.log("log export read failed", tag: "diagnostics", level: .warn, fields: [
                    "file": name,
                    "offset": String(start),
                    "error": error.localizedDescription
                ])
                continue
            }
            guard let data = read, !data.isEmpty else { continue }
            // Writes are whole-line and serialized on this same queue, so the
            // tail always ends on a line boundary — no partial-line handling
            // is needed and the cursor can advance to `end`.
            let tail = String(decoding: data, as: UTF8.self)
            for line in tail.components(separatedBy: "\n") where !line.isEmpty {
                guard let seq = Self.parseSeq(line) else { continue }
                if seq > exportScannedMaxSeq { exportScannedMaxSeq = seq }
                if seq > sinceSeq {
                    // Advance maxSeq over all qualifying lines regardless of
                    // the pairing filter -- the cursor is global.
                    if seq > maxSeq { maxSeq = seq }
                    if let filterPairing = pairingId {
                        let linePairing = Self.parsePairingId(line)
                        if linePairing == nil {
                            withheldUnstamped += 1
                            continue
                        }
                        if linePairing != filterPairing {
                            withheldOtherPairing += 1
                            continue
                        }
                    }
                    newLines.append(line)
                }
            }
            exportFileOffsets[name] = end
        }

        // Resume cursor = highest seq passed over, shipped or withheld
        // (see doc comment; `maxSeq` above advances before the pairing
        // filter). The old `maxSeq + 1` inflated the cursor past the next
        // unwritten line,
        // and the strict-greater filter above (plus the desktop's
        // `seq <= mark` dedup) then dropped the line stamped exactly
        // maxSeq+1 — one line silently lost per non-empty pull cycle
        // (pre-existing off-by-one, fixed here).
        let nextSeq = maxSeq
        let newContent = newLines.isEmpty ? "" : newLines.joined(separator: "\n") + "\n"
        return IncrementalExport(
            logs: newContent,
            nextSeq: nextSeq,
            withheldUnstamped: withheldUnstamped,
            withheldOtherPairing: withheldOtherPairing
        )
    }

    /// Extract `fields.seq` from a single JSONL line. Returns nil when the line
    /// is unparseable or carries no numeric seq (pre-upgrade lines).
    static func parseSeq(_ line: String) -> Int? {
        guard let data = line.data(using: .utf8),
              // Unparseable lines return nil, as documented above.
              // swiftlint:disable:next silent_try_optional
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let fields = obj["fields"] as? [String: Any] else { return nil }
        if let n = fields["seq"] as? Int { return n }
        if let s = fields["seq"] as? String { return Int(s) }
        return nil
    }

    /// Extract `pairing_id` from a single JSONL line. Returns nil when the line
    /// is unparseable or carries no pairing_id (pre-upgrade lines or lines
    /// emitted while no desktop was paired).
    static func parsePairingId(_ line: String) -> String? {
        guard let data = line.data(using: .utf8),
              // Unparseable lines return nil, as documented above.
              // swiftlint:disable:next silent_try_optional
              let obj = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return nil }
        return obj["pairing_id"] as? String
    }
}

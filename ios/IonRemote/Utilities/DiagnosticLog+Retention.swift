import Foundation

// MARK: - Segment rotation and ship-aware retention
//
// The log on disk is a run of segments. `current.log` takes new lines; when it
// passes `segmentMaxBytes`, or at the next app launch, it is renamed
// `session-{sessionTag}-{maxSeq}.log`. The server's pull reads every segment,
// so rotation never hides a line from it.
//
// A segment is deleted only once every paired server that owns lines in it
// has confirmed holding them, and then only to keep the log near
// `shippedRetentionBytes`. Unconfirmed segments are deleted only past
// `maxRetainedBytes`, and each such delete writes a WARN line that ships, so
// the server sees the exact seq range it will never receive.

extension DiagnosticLog {

    /// Size at which `current.log` becomes a segment. Bounds what one delete
    /// frees and what one launch-time scan reads. A var so tests can force a
    /// rotation without writing a megabyte.
    static var segmentMaxBytes: UInt64 = 1_048_576

    /// Segments every server already holds are kept up to this total, so the
    /// on-device viewer and share sheet still have recent history.
    static let shippedRetentionBytes: UInt64 = 10_485_760

    /// Hard ceiling for the whole log. Only past this size is a segment some
    /// server has not confirmed deleted.
    static let maxRetainedBytes: UInt64 = 104_857_600

    static let currentLogName = "current.log"
    static let segmentIndexName = "segments.json"
    static let sessionTagDefaultsKey = "com.ion.diag.sessionTag"
    /// pairing id → highest seq that pairing's server has confirmed holding.
    static let shippedMarksDefaultsKey = "com.ion.diag.shippedSeq"
    /// The pairing ids this phone is paired with. Absent until the app first
    /// reports them, and while absent every pairing's lines are kept.
    static let knownPairingsDefaultsKey = "com.ion.diag.knownPairings"

    /// What one segment holds, as far as retention cares.
    struct SegmentSummary: Codable, Equatable, Sendable {
        /// Highest seq in the segment (any pairing, or none).
        var maxSeq: Int
        /// Highest seq each pairing wrote into the segment. A line with no
        /// pairing ships to no server, so it never holds a segment back.
        var pairingMaxSeq: [String: Int]
    }

    struct RetainedSegment: Equatable, Sendable {
        let name: String
        let bytes: UInt64
        let summary: SegmentSummary
    }

    struct RetentionDrop: Equatable, Sendable {
        let segment: RetainedSegment
        /// Pairings whose lines in the segment no server has confirmed.
        /// Empty for a segment every server already holds.
        let unshippedPairings: [String]
    }

    // MARK: - Retention policy (pure)

    /// The segments to delete, given `segments` oldest first. Confirmed
    /// segments go first, oldest first, while the log is over `shippedBudget`.
    /// Unconfirmed segments go, oldest first, only while it is over `hardCap`.
    static func retentionPlan(
        segments: [RetainedSegment],
        currentBytes: UInt64,
        shippedThrough: [String: Int],
        knownPairings: Set<String>?,
        shippedBudget: UInt64,
        hardCap: UInt64
    ) -> [RetentionDrop] {
        var total = segments.reduce(currentBytes) { $0 + $1.bytes }
        var kept: [RetainedSegment] = []
        var drops: [RetentionDrop] = []
        for segment in segments {
            let unshipped = unshippedPairings(segment.summary, shippedThrough: shippedThrough, knownPairings: knownPairings)
            if total > shippedBudget, unshipped.isEmpty {
                drops.append(RetentionDrop(segment: segment, unshippedPairings: []))
                total -= segment.bytes
            } else {
                kept.append(segment)
            }
        }
        for segment in kept where total > hardCap {
            let unshipped = unshippedPairings(segment.summary, shippedThrough: shippedThrough, knownPairings: knownPairings)
            drops.append(RetentionDrop(segment: segment, unshippedPairings: unshipped))
            total -= segment.bytes
        }
        return drops
    }

    /// Pairings that still need lines from a segment: still paired (or the
    /// pairing list is not known yet) and not confirmed through their last
    /// line in it.
    static func unshippedPairings(
        _ summary: SegmentSummary,
        shippedThrough: [String: Int],
        knownPairings: Set<String>?
    ) -> [String] {
        summary.pairingMaxSeq.compactMap { pairing, lastSeq in
            if let known = knownPairings, !known.contains(pairing) { return nil }
            return (shippedThrough[pairing] ?? 0) >= lastSeq ? nil : pairing
        }.sorted()
    }

    // MARK: - Confirmations from the server

    /// Record that `pairingId`'s server holds every line through `seq`. The
    /// server only asks from a seq it has already saved, so its `sinceSeq` is
    /// the confirmation. writeQueue only.
    func _recordShippedOnQueue(pairingId: String, throughSeq seq: Int) {
        var marks = Self.loadShippedMarks()
        guard seq > (marks[pairingId] ?? 0) else { return }
        marks[pairingId] = seq
        UserDefaults.standard.set(marks, forKey: Self.shippedMarksDefaultsKey)
    }

    static func loadShippedMarks() -> [String: Int] {
        UserDefaults.standard.dictionary(forKey: shippedMarksDefaultsKey) as? [String: Int] ?? [:]
    }

    /// Tell the logger which servers this phone is paired with. Lines for a
    /// server that is no longer paired can never ship, so they stop holding
    /// segments back, and that server's confirmation mark is dropped.
    static func setKnownPairings(_ ids: [String]) {
        shared.writeQueue.async {
            let known = Set(ids)
            UserDefaults.standard.set(known.sorted(), forKey: knownPairingsDefaultsKey)
            let marks = loadShippedMarks().filter { known.contains($0.key) }
            UserDefaults.standard.set(marks, forKey: shippedMarksDefaultsKey)
        }
    }

    static func loadKnownPairings() -> Set<String>? {
        (UserDefaults.standard.array(forKey: knownPairingsDefaultsKey) as? [String]).map(Set.init)
    }

    // MARK: - Writing and rotation (writeQueue only)

    /// Append one encoded line to `current.log`, first rotating when the line
    /// would push it past `segmentMaxBytes`.
    func writeLine(_ line: String) {
        guard let data = line.data(using: .utf8) else { return }
        let limit = max(Self.segmentMaxBytes, nextRotationAttemptBytes)
        if currentSegmentBytes > 0, currentSegmentBytes + UInt64(data.count) > limit {
            rotateCurrentSegment(reason: "size")
        }
        if fileHandle == nil { openCurrentLog() }
        guard let handle = fileHandle else { return }
        handle.write(data)
        currentSegmentBytes += UInt64(data.count)
        let seq = _highestWrittenSeqOnQueue()
        currentSegment.maxSeq = max(currentSegment.maxSeq, seq)
        if let pairing = currentPairingId { currentSegment.pairingMaxSeq[pairing] = seq }
    }

    func openCurrentLog() {
        let fm = FileManager.default
        if !fm.fileExists(atPath: currentLogURL.path) {
            fm.createFile(atPath: currentLogURL.path, contents: nil)
        }
        do {
            fileHandle = try FileHandle(forWritingTo: currentLogURL)
            openFailureRecorded = false
        } catch {
            fileHandle = nil
            recordOpenFailure(error)
            return
        }
        // A reopened file already holding lines (a failed rotation) must keep
        // counting them, or its summary would under-report what it holds.
        currentSegmentBytes = fileHandle?.seekToEndOfFile() ?? 0
        currentSegment = currentSegmentBytes > 0
            ? Self.scanSummary(of: currentLogURL)
            : SegmentSummary(maxSeq: 0, pairingMaxSeq: [:])
    }

    /// Close `current.log` and rename it to a segment under `sessionTag`, then
    /// apply retention. The next write opens a fresh `current.log`.
    func rotateCurrentSegment(reason: String) {
        let fm = FileManager.default
        let size = Self.fileSize(currentLogURL)
        guard size > 0 else { return }
        let summary = fileHandle != nil ? currentSegment : Self.scanSummary(of: currentLogURL)
        closeCurrentLog()

        let name = "session-\(sessionTag)-\(String(format: "%012d", summary.maxSeq)).log"
        do {
            try fm.moveItem(at: currentLogURL, to: logDirectory.appendingPathComponent(name))
        } catch {
            nextRotationAttemptBytes = size + Self.segmentMaxBytes
            append("log rotation move failed", tag: "diagnostics", level: .error, fields: [
                "file": name,
                "reason": reason,
                "error": error.localizedDescription
            ])
            return
        }
        nextRotationAttemptBytes = 0
        // The export cursor's offset into current.log now addresses this
        // segment. Left under current.log it would skip the new file's lines.
        if let offset = exportFileOffsets.removeValue(forKey: Self.currentLogName) {
            exportFileOffsets[name] = offset
        }
        segmentIndex[name] = summary
        currentSegment = SegmentSummary(maxSeq: 0, pairingMaxSeq: [:])
        currentSegmentBytes = 0
        pruneSegments()
    }

    private func closeCurrentLog() {
        guard let handle = fileHandle else { return }
        fileHandle = nil
        do {
            try handle.close()
        } catch {
            append("log file close failed", tag: "diagnostics", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    /// Apply `retentionPlan` to the segments on disk.
    func pruneSegments() {
        let names = allLogFiles()
        var indexChanged = false
        let segments = names.map { name -> RetainedSegment in
            let url = logDirectory.appendingPathComponent(name)
            let summary: SegmentSummary
            if let known = segmentIndex[name] {
                summary = known
            } else {
                summary = Self.scanSummary(of: url)
                segmentIndex[name] = summary
                indexChanged = true
            }
            return RetainedSegment(name: name, bytes: Self.fileSize(url), summary: summary)
        }
        let live = Set(names)
        for name in segmentIndex.keys where !live.contains(name) {
            segmentIndex.removeValue(forKey: name)
            indexChanged = true
        }

        let drops = Self.retentionPlan(
            segments: segments,
            currentBytes: currentSegmentBytes,
            shippedThrough: Self.loadShippedMarks(),
            knownPairings: Self.loadKnownPairings(),
            shippedBudget: Self.shippedRetentionBytes,
            hardCap: Self.maxRetainedBytes
        )
        // The seq just before each segment, so a dropped range is exact.
        var seqBefore: [String: Int] = [:]
        var previous = 0
        for segment in segments {
            seqBefore[segment.name] = previous
            previous = max(previous, segment.summary.maxSeq)
        }
        for drop in drops {
            let name = drop.segment.name
            guard removeSessionFile(named: name) else { continue }
            segmentIndex.removeValue(forKey: name)
            exportFileOffsets.removeValue(forKey: name)
            indexChanged = true
            guard !drop.unshippedPairings.isEmpty else { continue }
            append("log segment dropped before shipping", tag: "diagnostics", level: .warn, fields: [
                "file": name,
                "bytes": String(drop.segment.bytes),
                "after_seq": String(seqBefore[name] ?? 0),
                "through_seq": String(drop.segment.summary.maxSeq),
                "pairings": drop.unshippedPairings.joined(separator: ","),
                "cap_bytes": String(Self.maxRetainedBytes)
            ])
        }
        if indexChanged { saveSegmentIndex() }
    }

    private func removeSessionFile(named name: String) -> Bool {
        do {
            try FileManager.default.removeItem(at: logDirectory.appendingPathComponent(name))
            return true
        } catch {
            append("log prune remove failed", tag: "diagnostics", level: .warn, fields: [
                "file": name,
                "error": error.localizedDescription
            ])
            return false
        }
    }

    /// Rotated segment names, oldest first (current.log excluded).
    func allLogFiles() -> [String] {
        // An unlistable directory has no segments to read or prune; the
        // current.log open failure is what records that outage.
        // swiftlint:disable:next silent_try_optional
        let contents = (try? FileManager.default.contentsOfDirectory(atPath: logDirectory.path)) ?? []
        return contents.filter { $0.hasPrefix("session-") && $0.hasSuffix(".log") }.sorted()
    }

    // MARK: - Segment index

    func loadSegmentIndex() {
        let url = logDirectory.appendingPathComponent(Self.segmentIndexName)
        guard FileManager.default.fileExists(atPath: url.path) else { return }
        do {
            segmentIndex = try JSONDecoder().decode([String: SegmentSummary].self, from: Data(contentsOf: url))
        } catch {
            // Every segment is rescanned on the next prune, so nothing is lost.
            segmentIndex = [:]
            append("log segment index unreadable", tag: "diagnostics", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    private func saveSegmentIndex() {
        let url = logDirectory.appendingPathComponent(Self.segmentIndexName)
        do {
            try JSONEncoder().encode(segmentIndex).write(to: url, options: .atomic)
        } catch {
            append("log segment index save failed", tag: "diagnostics", level: .warn, fields: [
                "error": error.localizedDescription
            ])
        }
    }

    // MARK: - Helpers

    static func scanSummary(of url: URL) -> SegmentSummary {
        var summary = SegmentSummary(maxSeq: 0, pairingMaxSeq: [:])
        // An unreadable file summarizes as empty: it holds nothing the export
        // could read either, and the export logs that failure itself.
        // swiftlint:disable:next silent_try_optional
        guard let text = try? String(contentsOf: url, encoding: .utf8) else { return summary }
        for line in text.split(separator: "\n") {
            let line = String(line)
            guard let seq = parseSeq(line) else { continue }
            summary.maxSeq = max(summary.maxSeq, seq)
            if let pairing = parsePairingId(line) {
                summary.pairingMaxSeq[pairing] = max(summary.pairingMaxSeq[pairing] ?? 0, seq)
            }
        }
        return summary
    }

    static func fileSize(_ url: URL) -> UInt64 {
        // A missing file is size 0, which is what every caller wants.
        // swiftlint:disable:next silent_try_optional
        let attrs = try? FileManager.default.attributesOfItem(atPath: url.path)
        return (attrs?[.size] as? NSNumber)?.uint64Value ?? 0
    }

    static func makeSessionTag(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date).replacingOccurrences(of: ":", with: "-")
    }

    /// The launch tag in a segment name. Names from before size rotation
    /// (`session-{ts}.log`) are their own tag.
    static func sessionTag(ofSegment name: String) -> String {
        let stem = String(name.dropFirst("session-".count).dropLast(".log".count))
        let parts = stem.split(separator: "-", omittingEmptySubsequences: false)
        guard let last = parts.last, last.count == 12, last.allSatisfy(\.isNumber) else { return stem }
        return parts.dropLast().joined(separator: "-")
    }
}

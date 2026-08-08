package utils

// log_egress_spool.go — on-disk spool mechanics for the egress forwarder.
//
// Split out of log_egress.go because every function here obeys one invariant
// that the rest of the forwarder does not have to think about:
//
//	NOTHING IN THIS FILE MAY HOLD THE WHOLE SPOOL IN MEMORY.
//
// The spool is the buffer of last resort for a dead sink. It is capped by
// EgressSpoolMaxBytes (default 50 MB), but the file on disk can legitimately
// be far larger than the cap at the moment a function here runs: an unclean
// shutdown, a cap lowered between runs, or an earlier trim that never
// completed all leave an oversized file behind. A helper that reads the file
// into a []byte, splits it into a []string, and re-joins it is therefore not
// "usually fine" — it is a heap bomb waiting for the first operator whose sink
// rejects auth for a few days.
//
// That is not hypothetical. The original implementation trimmed with
//
//	for len(strings.Join(lines, "\n")+"\n") > maxBytes { lines = lines[1:] }
//
// which re-serializes the entire spool on every dropped line: O(n²) in the
// spool size. Against a 1.37 GB spool (3.4 M records, 27× the 50 MB cap, grown
// while an OTLP sink returned 401) that loop needed ~3.3 M iterations over
// ~1.3 GB each. The flush goroutine pegged a core at 100 %, the heap reached
// 9.5 GB, GC thrash starved the rest of the process, and the engine never
// reached its socket bind — every conversation on the machine went dark and no
// rebuild fixed it, because the state was on disk, not in the binary.
//
// So: read forward with a bufio.Reader, write through a temp file, rename into
// place, and let the byte offsets do the bookkeeping. Peak memory for any
// operation here is one chunk of records plus a fixed I/O buffer, regardless
// of how large the file has grown.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// spoolCopyBufferBytes is the fixed I/O buffer used when rewriting the spool.
// Peak rewrite memory is this buffer, not the file size.
const spoolCopyBufferBytes = 256 * 1024

// spoolReaderBufferBytes sizes the bufio.Reader used to parse spool lines.
// Records larger than this are still read correctly — ReadString grows a
// temporary as needed — the buffer only sets the syscall granularity.
const spoolReaderBufferBytes = 64 * 1024

// appendToSpool writes records to the on-disk spool, then trims to cap.
//
// Records are streamed through a buffered writer one at a time rather than
// joined into a single string: the caller may hand over the entire live
// buffer, and materializing that as one contiguous batch string is the same
// class of allocation this file exists to avoid.
func (f *EgressForwarder) appendToSpool(records []egressRecord) {
	if len(records) == 0 {
		return
	}

	f.spoolMu.Lock()
	defer f.spoolMu.Unlock()

	file, err := os.OpenFile(f.spoolPath, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err != nil {
		Error("log_egress", fmt.Sprintf("spool open failed (%d records dropped): %v", len(records), err))
		return
	}

	w := bufio.NewWriterSize(file, spoolCopyBufferBytes)
	written := 0
	var writeErr error
	for _, r := range records {
		b, err := json.Marshal(r)
		if err != nil {
			Error("log_egress", fmt.Sprintf("spool record marshal failed (record dropped): tag=%s err=%v", r.Tag, err))
			continue
		}
		b = append(b, '\n')
		if _, err := w.Write(b); err != nil {
			writeErr = err
			break
		}
		written++
	}

	if flushErr := w.Flush(); flushErr != nil && writeErr == nil {
		writeErr = flushErr
	}
	if closeErr := file.Close(); closeErr != nil {
		Error("log_egress", fmt.Sprintf("spool file close failed: %v", closeErr))
	}
	if writeErr != nil {
		Error("log_egress", fmt.Sprintf("spool write failed after %d/%d records: %v", written, len(records), writeErr))
		// Fall through to the trim: a partial write still grew the file.
	} else {
		Debug("log_egress", fmt.Sprintf("spool appended: %d records", written))
	}

	if err := f.trimSpoolToCapLocked(f.spoolMaxB); err != nil {
		Error("log_egress", fmt.Sprintf("spool trim failed: %v", err))
	}
}

// trimSpoolToCap ensures the spool file is at most maxBytes bytes by dropping
// whole records from the front (FIFO: oldest-first).
func (f *EgressForwarder) trimSpoolToCap(maxBytes int64) error {
	f.spoolMu.Lock()
	defer f.spoolMu.Unlock()
	return f.trimSpoolToCapLocked(maxBytes)
}

// trimSpoolToCapLocked is trimSpoolToCap with spoolMu already held.
//
// The trim is a single forward pass: the survivor is the last maxBytes bytes
// of the file, realigned forward to the next record boundary so the result is
// still valid JSONL. Cost is O(file size) in reads and O(1) in memory — it
// does not matter whether the file is 1 KB or 27× over cap.
func (f *EgressForwarder) trimSpoolToCapLocked(maxBytes int64) error {
	info, err := os.Stat(f.spoolPath)
	if err != nil {
		// Missing or unstattable — nothing to trim. Matches the pre-existing
		// contract: a trim is best-effort maintenance, not a delivery path.
		return nil
	}
	if maxBytes <= 0 || info.Size() <= maxBytes {
		return nil
	}

	before := info.Size()
	kept, dropped, err := f.rewriteSpoolFromOffsetLocked(before - maxBytes)
	if err != nil {
		return err
	}
	Error("log_egress", fmt.Sprintf(
		"spool cap exceeded: dropped %d oldest bytes, kept %d bytes (cap=%d, was=%d)",
		dropped, kept, maxBytes, before))
	return nil
}

// rewriteSpoolFromOffsetLocked rewrites the spool to contain only the bytes at
// or after offset, realigned forward to the next record boundary. Returns the
// number of bytes kept and dropped.
//
// The rewrite goes to a temp file and is renamed into place, so a crash
// mid-rewrite leaves the original spool intact rather than a truncated one.
// Callers must hold spoolMu.
func (f *EgressForwarder) rewriteSpoolFromOffsetLocked(offset int64) (kept int64, dropped int64, err error) {
	if offset < 0 {
		offset = 0
	}

	src, err := os.Open(f.spoolPath)
	if err != nil {
		return 0, 0, fmt.Errorf("spool open for rewrite: %w", err)
	}
	defer func() {
		if closeErr := src.Close(); closeErr != nil {
			Error("log_egress", fmt.Sprintf("spool source close failed during rewrite: %v", closeErr))
		}
	}()

	dropped = offset
	needsRealign := false
	if offset > 0 {
		// Is the offset already a record boundary? The drain path passes the
		// end of the last shipped chunk, which always is; the trim path passes
		// an arbitrary byte position, which usually is not. Realigning
		// unconditionally would eat one whole intact record every partial
		// drain — silent data loss that looks exactly like a delivery failure.
		var prev [1]byte
		if _, err := src.ReadAt(prev[:], offset-1); err != nil {
			return 0, 0, fmt.Errorf("spool boundary probe at %d: %w", offset-1, err)
		}
		needsRealign = prev[0] != '\n'

		if _, err := src.Seek(offset, io.SeekStart); err != nil {
			return 0, 0, fmt.Errorf("spool seek to %d: %w", offset, err)
		}
	}

	// All reading goes through this reader — including the realignment — so
	// buffered bytes are never lost between the two phases.
	r := bufio.NewReaderSize(src, spoolReaderBufferBytes)

	if needsRealign {
		// Discard the partial record straddling the offset. Without this the
		// surviving file starts mid-JSON and every drain would log a parse
		// failure for a record that was never malformed.
		n, err := discardThroughNewline(r)
		dropped += n
		if err != nil && !errors.Is(err, io.EOF) {
			return 0, 0, fmt.Errorf("spool realign after offset %d: %w", offset, err)
		}
	}

	tmpPath := f.spoolPath + ".tmp"
	dst, err := os.OpenFile(tmpPath, os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o644)
	if err != nil {
		return 0, 0, fmt.Errorf("spool temp open: %w", err)
	}

	kept, copyErr := io.CopyBuffer(dst, r, make([]byte, spoolCopyBufferBytes))
	closeErr := dst.Close()
	if copyErr != nil {
		if rmErr := os.Remove(tmpPath); rmErr != nil {
			Error("log_egress", fmt.Sprintf("spool temp cleanup failed after copy error: %v", rmErr))
		}
		return 0, 0, fmt.Errorf("spool rewrite copy: %w", copyErr)
	}
	if closeErr != nil {
		if rmErr := os.Remove(tmpPath); rmErr != nil {
			Error("log_egress", fmt.Sprintf("spool temp cleanup failed after close error: %v", rmErr))
		}
		return 0, 0, fmt.Errorf("spool temp close: %w", closeErr)
	}

	if kept == 0 {
		// Nothing survived — drop both files rather than leaving an empty spool.
		if rmErr := os.Remove(tmpPath); rmErr != nil {
			Error("log_egress", fmt.Sprintf("spool temp cleanup failed: %v", rmErr))
		}
		if rmErr := os.Remove(f.spoolPath); rmErr != nil && !os.IsNotExist(rmErr) {
			Error("log_egress", fmt.Sprintf("spool removal failed after full drop: %v", rmErr))
		}
		return 0, dropped, nil
	}

	if err := os.Rename(tmpPath, f.spoolPath); err != nil {
		if rmErr := os.Remove(tmpPath); rmErr != nil {
			Error("log_egress", fmt.Sprintf("spool temp cleanup failed after rename error: %v", rmErr))
		}
		return 0, 0, fmt.Errorf("spool rename: %w", err)
	}
	return kept, dropped, nil
}

// discardThroughNewline consumes bytes up to and including the next '\n',
// returning how many were consumed. Returns io.EOF when the reader ends
// without one (the caller treats that as "nothing survives").
func discardThroughNewline(r *bufio.Reader) (int64, error) {
	var n int64
	for {
		b, err := r.ReadByte()
		if err != nil {
			return n, err
		}
		n++
		if b == '\n' {
			return n, nil
		}
	}
}

// drainSpool streams spooled records to the configured targets in chunks,
// tracking a byte offset as each chunk lands.
//
// Chunking keeps POST bodies under the limits of intermediate proxies (500
// records at ~350 bytes ≈ 175 KB; Cloudflare caps at 100 MB, nginx/Traefik
// default to 1 MB). Streaming keeps peak memory at one chunk regardless of
// spool size — the whole file is never resident.
//
// On full success the spool file is removed. On partial failure the spool is
// rewritten to the unshipped tail, preserving FIFO order; the offset is the
// end of the last chunk that landed, so a shipped record is never re-sent and
// an unshipped one is never lost. Returns the first target error.
func (f *EgressForwarder) drainSpool() error {
	// A drain can be entered concurrently by the flush goroutine and by a
	// batch-size-triggered Flush on a logging goroutine. Two concurrent drains
	// would double-ship and clobber each other's rewrite, so the second one
	// yields: its records are still on disk and the next tick picks them up.
	if !f.spoolMu.TryLock() {
		Debug("log_egress", "spool drain skipped: another flush holds the spool")
		return nil
	}
	defer f.spoolMu.Unlock()

	info, err := os.Stat(f.spoolPath)
	if err != nil {
		if !os.IsNotExist(err) {
			Error("log_egress", fmt.Sprintf("spool stat failed (drain skipped): %v", err))
		}
		return nil
	}
	if info.Size() == 0 {
		return nil
	}

	chunkSize := f.cfg.EgressChunkSize
	if chunkSize <= 0 {
		chunkSize = defaultEgressChunkSize
	}

	file, err := os.Open(f.spoolPath)
	if err != nil {
		Error("log_egress", fmt.Sprintf("spool open for drain failed: %v", err))
		return nil
	}
	r := bufio.NewReaderSize(file, spoolReaderBufferBytes)

	var (
		consumed  int64 // bytes belonging to chunks that shipped successfully
		pending   int64 // bytes of the chunk currently being assembled
		shipped   int
		corrupt   int
		exportErr error
		readErr   error
		chunk     = make([]egressRecord, 0, chunkSize)
	)

	for {
		line, err := r.ReadString('\n')
		pending += int64(len(line))

		if trimmed := strings.TrimSpace(line); trimmed != "" {
			var rec egressRecord
			if json.Unmarshal([]byte(trimmed), &rec) == nil {
				chunk = append(chunk, rec)
			} else {
				// Consumed but unshippable. Counting it as consumed is what
				// stops one corrupt line from wedging the spool forever.
				corrupt++
			}
		}

		atEnd := err != nil
		if atEnd && !errors.Is(err, io.EOF) {
			readErr = err
		}

		if len(chunk) >= chunkSize || atEnd {
			if len(chunk) > 0 {
				if e := f.exportRecords(chunk); e != nil {
					exportErr = e
					break
				}
				Debug("log_egress", fmt.Sprintf("spool chunk shipped: %d records (offset %d)", len(chunk), consumed))
				shipped += len(chunk)
				chunk = chunk[:0]
			}
			consumed += pending
			pending = 0
		}

		if atEnd {
			break
		}
	}

	if closeErr := file.Close(); closeErr != nil {
		Error("log_egress", fmt.Sprintf("spool file close failed after drain: %v", closeErr))
	}

	if corrupt > 0 {
		Error("log_egress", fmt.Sprintf("spool drain skipped %d unparseable records (consumed, not shipped)", corrupt))
	}

	// Anything short of a clean read-to-EOF-and-ship leaves the tail on disk.
	if exportErr != nil || readErr != nil {
		if readErr != nil {
			Error("log_egress", fmt.Sprintf("spool read failed mid-drain after %d records: %v", shipped, readErr))
		}
		if consumed > 0 {
			if _, _, err := f.rewriteSpoolFromOffsetLocked(consumed); err != nil {
				Error("log_egress", fmt.Sprintf("spool partial-drain rewrite failed (double-delivery possible): %v", err))
			}
		}
		if exportErr != nil {
			return exportErr
		}
		return nil
	}

	if err := os.Remove(f.spoolPath); err != nil && !os.IsNotExist(err) {
		Error("log_egress", fmt.Sprintf("spool removal after full drain failed: %v", err))
	}
	if shipped > 0 {
		Log("log_egress", fmt.Sprintf("spool drained: %d records shipped", shipped))
	}
	return nil
}

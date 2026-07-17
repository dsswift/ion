// log_egress_tailer.go — engine-side tailer for non-engine log sources.
//
// The shipping-responsibility matrix (LoggingConfig.EgressShipSources) can
// assign the engine sources beyond its own records: the desktop's
// desktop.jsonl, the iOS diagnostic log, and the telemetry file. This
// tailer is the engine counterpart of the desktop's log-egress-tailer.ts —
// it polls each assigned file, parses appended JSONL lines into egress
// records, and feeds them through the active forwarder (which authenticates
// each flush via the operator token provider).
//
// Cursor semantics: offsets persist in ~/.ion/.engine-egress-tailer-cursors.json
// so an engine restart neither re-ships history nor drops in-between lines.
// A file first seen with no cursor starts at EOF (no historical backfill).
// A file smaller than its cursor was truncated or rotated in place; the
// cursor resets to zero so the fresh content ships from the top.
package utils

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// egressTailerPollInterval matches the desktop tailer's 2 s cadence.
const egressTailerPollInterval = 2 * time.Second

// egressTailSourceFiles maps matrix source names to the ~/.ion file each
// tails. "engine" is absent by design: the engine's own records ship
// in-process through EgressForwarder.ship, never via file tailing.
func egressTailSourceFiles(home string) map[string]string {
	ionDir := filepath.Join(home, ".ion")
	return map[string]string{
		"desktop":   filepath.Join(ionDir, "desktop.jsonl"),
		"ios":       filepath.Join(ionDir, "ios-diagnostic-logs.jsonl"),
		"telemetry": filepath.Join(ionDir, "telemetry.jsonl"),
	}
}

// EgressTailer polls assigned source files and ships appended lines.
type EgressTailer struct {
	files      map[string]string // source name -> path
	cursorPath string
	fwd        *EgressForwarder

	mu      sync.Mutex
	cursors map[string]int64 // path -> byte offset

	stopCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once
}

// StartEgressTailer starts a tailer for the non-engine sources in the
// resolved matrix. Returns nil when no tailed sources are assigned or the
// forwarder is nil (no egress configured). Call Stop on shutdown.
func StartEgressTailer(sources []string, fwd *EgressForwarder) *EgressTailer {
	if fwd == nil {
		return nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		Error("log_egress_tailer", "cannot determine home dir; tailer disabled: "+err.Error())
		return nil
	}
	available := egressTailSourceFiles(home)
	files := make(map[string]string)
	for _, s := range sources {
		if path, ok := available[s]; ok {
			files[s] = path
		}
	}
	if len(files) == 0 {
		return nil
	}

	t := &EgressTailer{
		files:      files,
		cursorPath: filepath.Join(home, ".ion", ".engine-egress-tailer-cursors.json"),
		fwd:        fwd,
		cursors:    make(map[string]int64),
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
	t.loadCursors()

	// First-seen files (no persisted cursor) start at EOF: shipping a
	// file's entire history on first assignment would flood the sink.
	for _, path := range files {
		if _, ok := t.cursors[path]; !ok {
			if info, statErr := os.Stat(path); statErr == nil {
				t.cursors[path] = info.Size()
			} else {
				t.cursors[path] = 0
			}
		}
	}

	names := make([]string, 0, len(files))
	for s := range files {
		names = append(names, s)
	}
	LogWithFields(LevelInfo, "log_egress_tailer", "tailer started", map[string]any{"status": names})

	go t.loop()
	return t
}

// Stop halts polling and persists cursors. Idempotent.
func (t *EgressTailer) Stop() {
	if t == nil {
		return
	}
	t.stopOnce.Do(func() {
		close(t.stopCh)
		<-t.doneCh
	})
}

func (t *EgressTailer) loop() {
	defer close(t.doneCh)
	ticker := time.NewTicker(egressTailerPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			for source, path := range t.files {
				t.pollFile(source, path)
			}
		case <-t.stopCh:
			// Final poll so shutdown doesn't strand lines written since the
			// last tick, then persist cursors.
			for source, path := range t.files {
				t.pollFile(source, path)
			}
			t.saveCursors()
			return
		}
	}
}

// pollFile ships lines appended to path since the last cursor position.
func (t *EgressTailer) pollFile(source, path string) {
	info, err := os.Stat(path)
	if err != nil {
		return // absent file: nothing to ship (e.g. no iOS device paired)
	}

	t.mu.Lock()
	offset := t.cursors[path]
	t.mu.Unlock()

	if info.Size() < offset {
		// Truncated or rotated in place: restart from the top so the fresh
		// content ships. Matches the desktop tailer's truncate handling.
		LogWithFields(LevelInfo, "log_egress_tailer", "file shrank; cursor reset", map[string]any{"path": path, "count": int(info.Size())})
		offset = 0
	}
	if info.Size() == offset {
		return
	}

	f, err := os.Open(path)
	if err != nil {
		Error("log_egress_tailer", "open failed: "+err.Error())
		return
	}
	defer func() { _ = f.Close() }()

	if _, err := f.Seek(offset, 0); err != nil {
		Error("log_egress_tailer", "seek failed: "+err.Error())
		return
	}

	data := make([]byte, info.Size()-offset)
	n, err := f.Read(data)
	if err != nil && n == 0 {
		return
	}
	data = data[:n]

	// Ship only complete lines; a partially-written trailing line stays
	// un-consumed for the next poll.
	consumed := 0
	shipped := 0
	for {
		nl := bytes.IndexByte(data[consumed:], '\n')
		if nl < 0 {
			break
		}
		line := strings.TrimSpace(string(data[consumed : consumed+nl]))
		consumed += nl + 1
		if line == "" {
			continue
		}
		var rec egressRecord
		if err := json.Unmarshal([]byte(line), &rec); err != nil {
			// Non-canonical line: ship it losslessly as the message body
			// rather than dropping it silently.
			rec = egressRecord{
				Ts:        time.Now().UTC().Format(time.RFC3339Nano),
				Level:     "INFO",
				Msg:       line,
				Component: source,
				Tag:       "tailer_raw",
			}
		} else if rec.Msg == "" {
			// Valid JSON but no "msg" field — most likely a telemetry event,
			// which uses "name" not "msg". Ship the raw line as the body so
			// the downstream OTLP exporter has non-empty content and the record
			// is not silently discarded as an empty log line. The stream labels
			// (component, level) are still populated from the parsed struct.
			rec.Msg = line
		}
		if rec.Component == "" {
			rec.Component = source
		}
		if rec.User == "" {
			rec.User = resolvedEgressUser()
		}
		t.fwd.shipTailed(rec)
		shipped++
	}

	t.mu.Lock()
	t.cursors[path] = offset + int64(consumed)
	t.mu.Unlock()

	if shipped > 0 {
		LogWithFields(LevelDebug, "log_egress_tailer", "lines shipped", map[string]any{"path": path, "count": shipped})
		t.saveCursors()
	}
}

func (t *EgressTailer) loadCursors() {
	data, err := os.ReadFile(t.cursorPath)
	if err != nil {
		return
	}
	var cursors map[string]int64
	if err := json.Unmarshal(data, &cursors); err != nil {
		LogWithFields(LevelInfo, "log_egress_tailer", "cursor file unreadable; starting fresh", map[string]any{"error": err.Error()})
		return
	}
	t.mu.Lock()
	t.cursors = cursors
	t.mu.Unlock()
}

func (t *EgressTailer) saveCursors() {
	t.mu.Lock()
	data, err := json.Marshal(t.cursors)
	t.mu.Unlock()
	if err != nil {
		return
	}
	if err := os.WriteFile(t.cursorPath, data, 0o600); err != nil {
		Error("log_egress_tailer", "cursor persist failed: "+err.Error())
	}
}

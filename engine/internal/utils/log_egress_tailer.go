// log_egress_tailer.go — engine-side tailer for non-engine log sources.
package utils

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/filetail"
)

// egressTailerPollInterval matches the desktop tailer's 2 s cadence.
const egressTailerPollInterval = 2 * time.Second

// egressTailSourceFiles maps matrix source names to the ~/.ion file each
// tails. "engine" is absent by design: engine records ship in-process.
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

	mu       sync.Mutex
	tailers  map[string]*filetail.Follower // path -> held-FD follower
	cursors  map[string]filetail.Cursor    // path -> durable cursor
	stopCh   chan struct{}
	doneCh   chan struct{}
	stopOnce sync.Once
}

// StartEgressTailer starts a tailer for non-engine sources assigned to the
// engine. First-seen files start at EOF to avoid historical backfill.
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
	for _, source := range sources {
		if path, ok := available[source]; ok {
			files[source] = path
		}
	}
	if len(files) == 0 {
		return nil
	}

	t := &EgressTailer{
		files:      files,
		cursorPath: filepath.Join(home, ".ion", ".engine-egress-tailer-cursors.json"),
		fwd:        fwd,
		tailers:    make(map[string]*filetail.Follower),
		cursors:    make(map[string]filetail.Cursor),
		stopCh:     make(chan struct{}),
		doneCh:     make(chan struct{}),
	}
	t.loadCursors()

	names := make([]string, 0, len(files))
	for source := range files {
		names = append(names, source)
	}
	LogWithFields(LevelInfo, "log_egress_tailer", "tailer started", map[string]any{"status": names})
	go t.loop()
	return t
}

// Stop halts polling, drains complete lines, and persists cursors. It is safe
// to call more than once.
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
	defer t.closeFollowers()
	ticker := time.NewTicker(egressTailerPollInterval)
	defer ticker.Stop()
	for {
		select {
		case <-ticker.C:
			t.pollAll()
		case <-t.stopCh:
			t.pollAll()
			t.saveCursors()
			return
		}
	}
}

func (t *EgressTailer) pollAll() {
	for source, path := range t.files {
		t.pollFile(source, path)
	}
}

// pollFile drains one source. An absent path is normal: for example, no iOS
// device may have written its diagnostic log yet.
func (t *EgressTailer) pollFile(source, path string) {
	follower := t.follower(path)
	before := follower.Cursor()
	err := follower.Poll(func(line []byte) error {
		return t.handleLine(source, line)
	})
	if err != nil {
		if !errors.Is(err, os.ErrNotExist) {
			Error("log_egress_tailer", "file poll failed: "+err.Error())
		}
		return
	}
	after := follower.Cursor()
	if after == before {
		return
	}
	t.mu.Lock()
	t.cursors[path] = after
	t.mu.Unlock()
	t.saveCursors()
}

func (t *EgressTailer) follower(path string) *filetail.Follower {
	t.mu.Lock()
	defer t.mu.Unlock()
	if follower := t.tailers[path]; follower != nil {
		return follower
	}
	if t.tailers == nil {
		t.tailers = make(map[string]*filetail.Follower)
	}
	follower := filetail.New(path, filetail.Options{
		Start:  filetail.StartAtEnd,
		Cursor: t.cursors[path],
	})
	t.tailers[path] = follower
	return follower
}

// handleLine is the narrow source-to-egress seam. Later integrations can
// replace this conversion without changing file cursor acknowledgement.
func (t *EgressTailer) handleLine(source string, raw []byte) error {
	line := strings.TrimSpace(string(raw))
	if line == "" {
		return nil
	}
	var rec egressRecord
	if err := json.Unmarshal([]byte(line), &rec); err != nil {
		rec = egressRecord{
			Ts:        time.Now().UTC().Format(time.RFC3339Nano),
			Level:     "INFO",
			Msg:       line,
			Component: source,
			Tag:       "tailer_raw",
		}
	} else if !isTelemetryEventRecord(rec) && rec.Msg == "" {
		rec.Msg = line
	}
	if rec.Component == "" {
		rec.Component = source
	}
	if rec.User == "" {
		rec.User = resolvedEgressUser()
	}
	// shipTailed has accepted the record when it returns. Only then does the
	// filetail follower advance its durable cursor.
	t.fwd.shipTailed(rec)
	return nil
}

func (t *EgressTailer) closeFollowers() {
	t.mu.Lock()
	defer t.mu.Unlock()
	for path, follower := range t.tailers {
		if err := follower.Close(); err != nil {
			Error("log_egress_tailer", "file close failed: "+err.Error())
		}
		delete(t.tailers, path)
	}
}

func (t *EgressTailer) loadCursors() {
	data, err := os.ReadFile(t.cursorPath)
	if err != nil {
		return
	}
	var cursors map[string]filetail.Cursor
	if err := json.Unmarshal(data, &cursors); err == nil {
		t.mu.Lock()
		t.cursors = cursors
		t.mu.Unlock()
		return
	}

	// Versions before filetail stored path -> byte offset. Keep those cursors
	// useful, while allowing the follower to bind them to the next inode.
	var legacy map[string]int64
	if err := json.Unmarshal(data, &legacy); err != nil {
		LogWithFields(LevelInfo, "log_egress_tailer", "cursor file unreadable; starting fresh", map[string]any{"error": err.Error()})
		return
	}
	migrated := make(map[string]filetail.Cursor, len(legacy))
	for path, offset := range legacy {
		migrated[path] = filetail.Cursor{Offset: offset, Initialized: true}
	}
	t.mu.Lock()
	t.cursors = migrated
	t.mu.Unlock()
}

func (t *EgressTailer) saveCursors() {
	t.mu.Lock()
	data, err := json.Marshal(t.cursors)
	t.mu.Unlock()
	if err != nil {
		Error("log_egress_tailer", "cursor marshal failed: "+err.Error())
		return
	}
	if err := AtomicWriteFile(t.cursorPath, data, 0o600); err != nil {
		Error("log_egress_tailer", "cursor persist failed: "+err.Error())
	}
}

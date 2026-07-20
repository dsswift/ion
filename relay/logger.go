package main

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

// slogLevelTrace is the custom slog.Level for TRACE — placed just below
// slog.LevelDebug so the handler floor of slogLevelTrace lets TRACE records
// through while Ion's own logLevel gate stays authoritative.
const slogLevelTrace = slog.LevelDebug - 4

// maxRelayLogBytes is the rename-rotate cap for the relay log file (20 MB),
// matching the engine's default maxLogSize. Declared as a var so tests can
// override it without modifying the source.
var maxRelayLogBytes int64 = 20 * 1024 * 1024

// maxRelayLogFiles is the number of rotated archive generations to keep
// alongside the live relay log. Overridable via RELAY_LOG_MAX_FILES env var.
// Matches the engine's compiled default of 3.
var maxRelayLogFiles = 3

// logMu guards relayLogFile, relayLogPath, and relayBytesWritten for rename-rotate rotation.
var (
	logMu             sync.Mutex
	relayLogFile      *os.File
	relayLogPath      string // absolute path to the live log file
	relayBytesWritten int64
)

// logger is the package-level root slog logger. It is initialized in main()
// via initLogger(). It is also given a safe default so code paths exercised
// by tests (which call HandleWebSocket without running main) never dereference
// a nil logger.
var logger = slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "relay")

// relayReplaceAttr normalises slog built-in keys for the canonical Ion log schema:
//   - "time"  → "ts" (RFC3339Nano UTC)
//   - "level" → uppercase string; custom TRACE value serialised as "TRACE" (not "DEBUG-4")
//   - "msg"   → kept as-is (slog already uses "msg")
//
// Note: "err" → "error" normalisation is applied by normalizeKey() in
// relayHandler.Handle before records reach the base handler, so it does not
// appear here.
func relayReplaceAttr(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
		a.Key = "ts"
		if t, ok := a.Value.Any().(time.Time); ok {
			a.Value = slog.StringValue(t.UTC().Format(time.RFC3339Nano))
		}
		return a
	case slog.LevelKey:
		if lv, ok := a.Value.Any().(slog.Level); ok && lv == slogLevelTrace {
			return slog.String("level", "TRACE")
		}
		// For standard levels slog already returns the uppercase canonical name.
		return slog.String("level", a.Value.String())
	}
	return a
}

// reserved is the set of top-level attribute keys emitted directly rather than
// nested under "fields". Extend this set when a new correlation ID is added.
var reserved = map[string]bool{
	"component":       true,
	"tag":             true,
	"session_id":      true,
	"conversation_id": true,
	"trace_id":        true,
	"channel_id":      true,
	"role":            true,
	"port":            true,
}

// relayHandler wraps a base slog.Handler to group all non-reserved top-level
// attributes under a nested "fields" object, matching the engine's logAtFull
// schema. Reserved keys (ts, level, component, tag, msg, session_id,
// conversation_id, trace_id, channel_id, role, port) are kept at the top level.
// All other call-site attributes are collected and emitted as "fields":{}
// (always present, even when empty).
type relayHandler struct {
	base  slog.Handler
	attrs []slog.Attr
}

func (h *relayHandler) Enabled(ctx context.Context, level slog.Level) bool {
	return h.base.Enabled(ctx, level)
}

func (h *relayHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &relayHandler{base: h.base, attrs: append(append([]slog.Attr{}, h.attrs...), attrs...)}
}

func (h *relayHandler) WithGroup(name string) slog.Handler {
	return &relayHandler{base: h.base.WithGroup(name), attrs: h.attrs}
}

// normalizeKey normalises ad-hoc attribute keys to their canonical schema names.
// Currently: "err" → "error". Extend here as new aliases are discovered.
func normalizeKey(k string) string {
	if k == "err" {
		return "error"
	}
	return k
}

func (h *relayHandler) Handle(ctx context.Context, r slog.Record) error {
	// Separate this record's attrs into reserved (top-level) and fieldsMap.
	// Normalize ad-hoc keys (e.g. "err" → "error") at collection time.
	fieldsMap := make(map[string]any)
	topAttrs := make([]slog.Attr, 0, len(h.attrs))

	for _, a := range h.attrs {
		if reserved[a.Key] {
			topAttrs = append(topAttrs, a)
		} else {
			fieldsMap[normalizeKey(a.Key)] = a.Value.Any()
		}
	}
	r.Attrs(func(a slog.Attr) bool {
		if reserved[a.Key] {
			topAttrs = append(topAttrs, a)
		} else {
			fieldsMap[normalizeKey(a.Key)] = a.Value.Any()
		}
		return true
	})

	// Build a new record containing only top-level (reserved) attrs plus a
	// canonical "fields" attribute, always present ({} when empty).
	nr := slog.NewRecord(r.Time, r.Level, r.Message, r.PC)
	for _, a := range topAttrs {
		nr.AddAttrs(a)
	}
	nr.AddAttrs(slog.Any("fields", fieldsMap))

	return h.base.Handle(ctx, nr)
}

// countingWriter wraps the relay log file for byte-counted rotation.
// It does not hold a direct *os.File reference; instead it reads relayLogFile
// (guarded by logMu) on every write so it always uses the current handle —
// even after rotateRelayLogLocked nils the old handle and reopens a fresh file.
// All writes run under logMu, so concurrent access is safe.
type countingWriter struct{}

func (c *countingWriter) Write(p []byte) (int, error) {
	logMu.Lock()
	if relayBytesWritten >= maxRelayLogBytes {
		rotateRelayLogLocked()
		// Reopen the log file after rotation so subsequent writes go to the
		// fresh file. relayLogPath is set once in initLogger and never changes.
		if relayLogPath != "" && relayLogFile == nil {
			f, err := os.OpenFile(relayLogPath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
			if err == nil {
				relayLogFile = f
			}
		}
	}
	if relayLogFile == nil {
		logMu.Unlock()
		return 0, nil // no file — silently drop (stdout path covers the user)
	}
	n, err := relayLogFile.Write(p)
	relayBytesWritten += int64(n)
	logMu.Unlock()
	return n, err
}

// rotateRelayLogLocked implements rename-rotate: shift existing generations
// (.1→.2, up to maxRelayLogFiles), rename the live file to .1, then close and
// nil the file handle so the next Write opens a fresh log file. Files beyond
// maxRelayLogFiles are removed before shifting. Must be called with logMu held.
func rotateRelayLogLocked() {
	if relayLogFile == nil || relayLogPath == "" {
		return
	}
	// Delete the oldest generation, then shift each one up.
	os.Remove(fmt.Sprintf("%s.%d", relayLogPath, maxRelayLogFiles)) //nolint:errcheck // log rotation cleanup; cannot log to the file being rotated
	for i := maxRelayLogFiles - 1; i >= 1; i-- {
		os.Rename(fmt.Sprintf("%s.%d", relayLogPath, i), fmt.Sprintf("%s.%d", relayLogPath, i+1)) //nolint:errcheck // log rotation shift; best-effort
	}
	// Close the current handle and rename the live file to .1.
	relayLogFile.Close() //nolint:errcheck // rotating out the old handle
	relayLogFile = nil
	os.Rename(relayLogPath, relayLogPath+".1") //nolint:errcheck // log rotation; best-effort
	relayBytesWritten = 0
}

// initLogger creates the root structured logger. RELAY_LOG_LEVEL controls
// verbosity (default INFO; "trace" sets TRACE which is below DEBUG).
// RELAY_LOG_FILE sets a JSONL file path (default /var/log/ion/relay.jsonl).
// RELAY_LOG_OUTPUT controls where log lines go: "stdout" (default for local dev),
// "file", or "both".
// RELAY_LOG_MAX_FILES sets the number of rotated archive generations to keep
// alongside the live file (default 3).
func initLogger() *slog.Logger {
	// ── Level ──────────────────────────────────────────────────────────────
	minLevel := slog.LevelInfo
	if v := strings.TrimSpace(os.Getenv("RELAY_LOG_LEVEL")); v != "" {
		switch strings.ToLower(v) {
		case "trace":
			minLevel = slogLevelTrace
		default:
			var l slog.Level
			if err := l.UnmarshalText([]byte(v)); err == nil {
				minLevel = l
			}
		}
	}

	// ── Max generations ────────────────────────────────────────────────────
	if v := strings.TrimSpace(os.Getenv("RELAY_LOG_MAX_FILES")); v != "" {
		var n int
		if _, err := fmt.Sscanf(v, "%d", &n); err == nil && n > 0 {
			maxRelayLogFiles = n
		}
	}

	// The base JSON handler floor is slogLevelTrace so it never silently drops
	// records; the levelGatedHandler enforces the configured minimum.
	handlerOpts := &slog.HandlerOptions{
		Level:       slogLevelTrace,
		ReplaceAttr: relayReplaceAttr,
	}

	// ── Output target ──────────────────────────────────────────────────────
	outputMode := strings.ToLower(strings.TrimSpace(os.Getenv("RELAY_LOG_OUTPUT")))
	if outputMode == "" {
		outputMode = "stdout" // default for backward compatibility and local dev
	}

	logFilePath := strings.TrimSpace(os.Getenv("RELAY_LOG_FILE"))
	if logFilePath == "" {
		logFilePath = "/var/log/ion/relay.jsonl"
	}

	var writers []io.Writer

	if outputMode == "file" || outputMode == "both" {
		if err := os.MkdirAll(filepath.Dir(logFilePath), 0o755); err == nil {
			logMu.Lock()
			relayLogPath = logFilePath
			if info, err := os.Stat(logFilePath); err == nil {
				relayBytesWritten = info.Size()
			}
			f, err := os.OpenFile(logFilePath, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
			if err == nil {
				relayLogFile = f
				writers = append(writers, &countingWriter{})
			}
			logMu.Unlock()
		}
	}
	if outputMode == "stdout" || outputMode == "both" || len(writers) == 0 {
		writers = append(writers, os.Stdout)
	}

	var dst io.Writer
	if len(writers) == 1 {
		dst = writers[0]
	} else {
		dst = io.MultiWriter(writers...)
	}

	// ── Build handler chain ────────────────────────────────────────────────
	base := slog.NewJSONHandler(dst, handlerOpts)
	h := &levelGatedHandler{
		inner: &relayHandler{base: base},
		min:   minLevel,
	}

	return slog.New(h).With("component", "relay")
}

// levelGatedHandler applies Ion's authoritative log-level gate on top of the
// relayHandler. The base JSONHandler uses slogLevelTrace as its floor so it
// never silently drops records; this wrapper enforces the configured minimum.
type levelGatedHandler struct {
	inner slog.Handler
	min   slog.Level
}

func (g *levelGatedHandler) Enabled(_ context.Context, level slog.Level) bool {
	return level >= g.min
}

func (g *levelGatedHandler) Handle(ctx context.Context, r slog.Record) error {
	if r.Level < g.min {
		return nil
	}
	return g.inner.Handle(ctx, r)
}

func (g *levelGatedHandler) WithAttrs(attrs []slog.Attr) slog.Handler {
	return &levelGatedHandler{inner: g.inner.WithAttrs(attrs), min: g.min}
}

func (g *levelGatedHandler) WithGroup(name string) slog.Handler {
	return &levelGatedHandler{inner: g.inner.WithGroup(name), min: g.min}
}

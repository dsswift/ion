package utils

import (
	"context"
	"fmt"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// LogLevel controls which messages are written to the log file.
type LogLevel int

const (
	// LevelTrace is the lowest level, below DEBUG. Use for high-frequency
	// internal tracing that would be too noisy even at DEBUG (e.g. per-token
	// stream ticks, per-iteration tool scheduler polls). Suppressed by default;
	// enable with SetLevel(LevelTrace) or engine.json logLevel="trace".
	LevelTrace LogLevel = iota
	LevelDebug
	LevelInfo
	LevelWarn
	LevelError
)

var levelNames = [...]string{"TRACE", "DEBUG", "INFO", "WARN", "ERROR"}

// slogLevelTrace is the custom slog.Level used for TRACE. We place it just
// below slog.LevelDebug so the slog handler does not suppress it when the
// handler minimum is set to slogLevelTrace.
const slogLevelTrace = slog.LevelDebug - 4

func (l LogLevel) String() string {
	if l >= 0 && int(l) < len(levelNames) {
		return levelNames[l]
	}
	return "INFO"
}

// ParseLevel converts a string like "trace", "debug", "info", "warn", "error"
// to a LogLevel. Returns LevelInfo for unrecognized strings.
func ParseLevel(s string) LogLevel {
	switch strings.ToLower(strings.TrimSpace(s)) {
	case "trace":
		return LevelTrace
	case "debug":
		return LevelDebug
	case "info":
		return LevelInfo
	case "warn", "warning":
		return LevelWarn
	case "error":
		return LevelError
	default:
		return LevelInfo
	}
}

// toSlogLevel maps our LogLevel to the corresponding slog.Level. slog's
// JSONHandler emits the canonical uppercase names ("DEBUG", "INFO", "WARN",
// "ERROR") for the standard levels, which matches the log schema exactly.
// LevelTrace maps to a custom value below slog.LevelDebug.
func toSlogLevel(level LogLevel) slog.Level {
	switch level {
	case LevelTrace:
		return slogLevelTrace
	case LevelDebug:
		return slog.LevelDebug
	case LevelInfo:
		return slog.LevelInfo
	case LevelWarn:
		return slog.LevelWarn
	case LevelError:
		return slog.LevelError
	default:
		return slog.LevelInfo
	}
}

// Size/rotation limits. These are vars (not consts) so ConfigureLogging can
// override them from LoggingConfig at startup.
var (
	maxLogSize      int64 = 20 * 1024 * 1024 // 20MB; overridden by LoggingConfig.MaxSizeMB
	maxLogFiles     int   = 3                 // archived generations; overridden by LoggingConfig.MaxFiles
	disableRotation       = false             // overridden by LoggingConfig.DisableRotation
)

// emptyFields is the canonical empty structured-context map. slog.Any renders
// it as {} so every line carries a "fields" object even when no context is
// supplied, per the log schema.
var emptyFields = map[string]any{}

var (
	logger       *slog.Logger
	logFile      *os.File
	logMu        sync.Mutex
	logLevel     = LevelInfo
	bytesWritten int64
	logDir       string
	// outputMode controls where log lines go: "file" (default), "stdout", or
	// "both". Overridden by LoggingConfig.OutputMode.
	outputMode = "file"
	// testSink, when non-nil, receives every structured log record in addition
	// to the file write. It exists purely as a test seam so unit tests can
	// assert on log output without reading ~/.ion/engine.jsonl. Production code
	// never sets it. Guarded by logMu. sessionID/conversationID carry the
	// resolved top-level correlation attributes (empty when absent) so tests
	// can assert on correlation without re-deriving them from a context.
	testSink func(level LogLevel, tag, msg string, fields map[string]any, sessionID, conversationID string)
	// activeEgressForwarder, when non-nil, receives every log record that passes
	// the level filter in addition to the file write. Initialized by
	// ConfigureLogging when LoggingConfig.EgressTargets is non-empty. Guarded
	// by logMu for initialization; the forwarder's own mutex protects its buffer.
	activeEgressForwarder *EgressForwarder
)

// countingWriter wraps an io.Writer and accumulates the number of bytes
// written into bytesWritten so the rotation check can run cheaply on the hot
// path without re-stat-ing the file. Not safe for concurrent use on its own;
// all writes happen under logMu.
type countingWriter struct {
	w io.Writer
}

func (c *countingWriter) Write(p []byte) (int, error) {
	n, err := c.w.Write(p)
	bytesWritten += int64(n)
	return n, err
}

// SetTestSink installs a callback that receives every log record that passes
// the current level filter, alongside the normal file write. Intended for
// tests only; pass nil to remove. To observe Debug lines, call
// SetLevel(LevelDebug) first. The sink runs while logMu is held, so callbacks
// must not call back into the logger. The final two arguments carry the
// resolved session_id/conversation_id top-level correlation attributes (empty
// when absent) so a sink can assert on correlation directly.
func SetTestSink(fn func(level LogLevel, tag, msg string, fields map[string]any, sessionID, conversationID string)) {
	logMu.Lock()
	testSink = fn
	logMu.Unlock()
}

// SetLevel sets the minimum log level. Messages below this level are discarded.
func SetLevel(level LogLevel) {
	logMu.Lock()
	logLevel = level
	logMu.Unlock()
}

// SetLevelFromString parses and sets the log level from a config string.
func SetLevelFromString(s string) {
	SetLevel(ParseLevel(s))
}

// GetLevel returns the current log level.
func GetLevel() LogLevel {
	logMu.Lock()
	defer logMu.Unlock()
	return logLevel
}

// ConfigureLogging wires config-driven values (size cap, output mode, log
// directory, rotation toggle) into the logger. Call once at startup, before
// the first log line, so initLogger picks up the overrides. A nil cfg is a
// no-op (compiled defaults stand).
func ConfigureLogging(cfg *types.LoggingConfig) {
	if cfg == nil {
		return
	}

	// Build the new egress forwarder BEFORE taking logMu. Construction is
	// self-contained (reads cfg, computes the spool path, starts flushLoop) and
	// may itself emit a log line — e.g. newEgressForwarder logs the "egress
	// delegated to managing client" suppression notice when EgressManagedByClient
	// is set (the desktop-launched path). Emitting a log line acquires logMu, so
	// constructing under logMu self-deadlocks on the non-reentrant mutex. Build
	// first, then swap the pointer under the lock. This mirrors the
	// Close()-after-unlock discipline below: no user-facing Log/Error call ever
	// runs while logMu is held.
	newForwarder := newEgressForwarder(*cfg)

	logMu.Lock()

	if cfg.MaxSizeMB > 0 {
		maxLogSize = int64(cfg.MaxSizeMB) * 1024 * 1024
	}
	if cfg.MaxFiles > 0 {
		maxLogFiles = cfg.MaxFiles
	}
	disableRotation = cfg.DisableRotation
	if cfg.OutputMode != "" {
		outputMode = cfg.OutputMode
	}
	if cfg.LogDir != "" {
		// logDir comes from human-edited engine.json and routinely arrives as
		// "~/...". Go performs no shell tilde expansion, so a literal "~" would
		// become a directory named "~". Expand before it reaches the filesystem.
		logDir = ExpandHomePath(cfg.LogDir)
	}

	// Force re-init on next write so the new destination/dir takes effect.
	if logFile != nil {
		_ = logFile.Close()
		logFile = nil
	}
	logger = nil

	// Swap the egress forwarder under the lock, but capture the previous one so
	// we can Close() it AFTER releasing logMu. Close() blocks on the old
	// forwarder's final flush, and a failing flush routes through logFlushError
	// → Error() → logAtFull, which re-acquires logMu. Closing under the lock
	// would therefore self-deadlock on any drain-time flush error. Closing
	// after unlock keeps the swap atomic while making the drain lock-free. The
	// new forwarder was built above, before the lock, for the same reason.
	prevForwarder := activeEgressForwarder
	activeEgressForwarder = newForwarder

	logMu.Unlock()

	if prevForwarder != nil {
		prevForwarder.Close()
	}
}

// ActiveEgressForwarder returns the current egress forwarder (nil when no
// egress is configured or the matrix assigns the engine no sources). Used
// at serve startup to attach the file tailer for non-engine matrix sources.
func ActiveEgressForwarder() *EgressForwarder {
	logMu.Lock()
	defer logMu.Unlock()
	return activeEgressForwarder
}

// Trace logs a message at TRACE level (below DEBUG). Suppressed by default;
// enable with SetLevel(LevelTrace).
func Trace(tag, msg string) {
	logAt(LevelTrace, tag, msg)
}

// TraceWithFields logs at TRACE level with structured fields.
func TraceWithFields(tag, msg string, fields map[string]any) {
	logAtWithFields(LevelTrace, tag, msg, fields)
}

// Debug logs a message at DEBUG level.
func Debug(tag, msg string) {
	logAt(LevelDebug, tag, msg)
}

// Info logs a message at INFO level.
func Info(tag, msg string) {
	logAt(LevelInfo, tag, msg)
}

// Warn logs a message at WARN level.
func Warn(tag, msg string) {
	logAt(LevelWarn, tag, msg)
}

// Error logs a message at ERROR level.
func Error(tag, msg string) {
	logAt(LevelError, tag, msg)
}

// Log writes a tagged message at INFO level. Backward compatible.
func Log(tag, msg string) {
	logAt(LevelInfo, tag, msg)
}

// LogWithFields logs at the given level with structured fields.
// tag is the subsystem tag. fields is optional (nil = {}).
func LogWithFields(level LogLevel, tag, msg string, fields map[string]any) {
	logAtWithFields(level, tag, msg, fields)
}

func logAt(level LogLevel, tag, msg string) {
	logAtWithFields(level, tag, msg, nil)
}

func logAtWithFields(level LogLevel, tag, msg string, fields map[string]any) {
	sessionID, conversationID, traceID := ambientCorrelationIDs()
	logAtFull(level, "engine", tag, msg, fields, sessionID, conversationID, traceID)
}

// logAtFull is the single structured-write path for all engine and extension
// log lines. component is stamped verbatim ("engine" or "extension");
// sessionID/conversationID/traceID are emitted as top-level attributes only
// when non-empty (the log schema omits absent correlation IDs rather than
// emitting empty strings). fields is emitted as the "fields" object, defaulting
// to {} when nil.
func logAtFull(level LogLevel, component, tag, msg string, fields map[string]any, sessionID, conversationID, traceID string) {
	logMu.Lock()

	if level < logLevel {
		logMu.Unlock()
		return
	}

	// Test seam: forward the structured record to the sink (if installed)
	// before the file write. Runs under logMu so the sink observes a
	// consistent ordering.
	if testSink != nil {
		testSink(level, tag, msg, fields, sessionID, conversationID)
	}

	if logger == nil {
		initLogger()
	}
	if logger == nil {
		logMu.Unlock()
		return
	}

	// Rotate if over the size limit, then re-init so the next write goes to the
	// fresh file. rotateLocked sets logger=nil; initLogger reopens the file.
	if !disableRotation && bytesWritten >= maxLogSize {
		rotateLocked()
		initLogger()
		if logger == nil {
			logMu.Unlock()
			return
		}
	}

	attrs := make([]slog.Attr, 0, 6)
	attrs = append(attrs,
		slog.String("component", component),
		slog.String("tag", tag),
	)
	if sessionID != "" {
		attrs = append(attrs, slog.String("session_id", sessionID))
	}
	if conversationID != "" {
		attrs = append(attrs, slog.String("conversation_id", conversationID))
	}
	if traceID != "" {
		attrs = append(attrs, slog.String("trace_id", traceID))
	}
	if fields != nil {
		attrs = append(attrs, slog.Any("fields", fields))
	} else {
		attrs = append(attrs, slog.Any("fields", emptyFields))
	}

	logger.LogAttrs(context.Background(), toSlogLevel(level), msg, attrs...)

	// Capture the egress forwarder under the lock, but ship AFTER releasing
	// logMu. ship may trigger a synchronous batch flush whose failure routes
	// through logFlushError → Error() → logAtFull, which re-acquires logMu;
	// shipping under the lock would self-deadlock. A synchronous HTTP POST
	// under the lock would also stall every other logger. Ship lock-free.
	fwd := activeEgressForwarder
	logMu.Unlock()

	// Forward to the egress sink when configured.
	if fwd != nil {
		fwd.ship(egressRecord{
			Ts:             time.Now().UTC().Format(time.RFC3339Nano),
			Level:          level.String(),
			Msg:            msg,
			Component:      component,
			Tag:            tag,
			SessionID:      sessionID,
			ConversationID: conversationID,
			TraceID:        traceID,
			User:           resolvedEgressUser(),
			Fields:         fields,
		})
	}
}

// schemaReplaceAttr remaps slog's built-in keys to the canonical log schema:
// time -> ts (RFC3339Nano UTC). level and msg already match the schema
// (slog emits "level" uppercase and "msg") for the four standard levels.
// The custom TRACE level (slogLevelTrace = DEBUG-4) is emitted by slog as
// "DEBUG-4"; we remap it here to the canonical uppercase "TRACE" string.
func schemaReplaceAttr(_ []string, a slog.Attr) slog.Attr {
	switch a.Key {
	case slog.TimeKey:
		return slog.String("ts", a.Value.Time().UTC().Format(time.RFC3339Nano))
	case slog.LevelKey:
		// slog represents levels as slog.Level values inside the Attr. For our
		// custom TRACE value (LevelDebug-4) the default String() produces
		// "DEBUG-4"; force it to the canonical schema string "TRACE".
		if lv, ok := a.Value.Any().(slog.Level); ok && lv == slogLevelTrace {
			return slog.String("level", "TRACE")
		}
		return slog.String("level", a.Value.String())
	case slog.MessageKey:
		return slog.String("msg", a.Value.String())
	}
	return a
}

// initLogger opens engine.jsonl, wires a byte-counting writer, and builds the
// slog handler. When ION_LOG_TEXT=1 is set (dev only), it swaps in a
// human-readable TextHandler writing to stderr instead of JSON-to-file.
// The handler minimum is set to slogLevelTrace (the lowest Ion level) so the
// handler never suppresses any record; Ion's own logLevel gate in logAtFull
// is the authoritative filter.
// Must be called with logMu held.
func initLogger() {
	// Dev-only human-readable path: text to stderr, no file.
	if os.Getenv("ION_LOG_TEXT") == "1" {
		h := slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{
			Level:       slogLevelTrace,
			ReplaceAttr: schemaReplaceAttr,
		})
		logger = slog.New(h)
		return
	}

	// Test-mode isolation: under `go test`, never fall back to the operator's
	// live ~/.ion/engine.jsonl. A test that wants to inspect log output
	// configures an explicit LogDir via ConfigureLogging, or installs a
	// SetTestSink (which fires in logAtFull before initLogger runs). The
	// default lazy path must go nowhere near ~/.ion.
	if testing.Testing() {
		home, _ := os.UserHomeDir()
		ionDir := filepath.Join(home, ".ion")
		if logDir == "" || logDir == ionDir {
			h := slog.NewJSONHandler(io.Discard, &slog.HandlerOptions{
				Level:       slogLevelTrace,
				ReplaceAttr: schemaReplaceAttr,
			})
			logger = slog.New(h)
			return
		}
	}

	if logDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return
		}
		logDir = filepath.Join(home, ".ion")
	}
	_ = os.MkdirAll(logDir, 0o700)

	var writers []io.Writer

	if outputMode == "file" || outputMode == "both" || outputMode == "" {
		path := filepath.Join(logDir, "engine.jsonl")
		// Seed the byte counter from the existing file so rotation accounts
		// for lines written by a previous process.
		if info, err := os.Stat(path); err == nil {
			bytesWritten = info.Size()
		}
		f, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0o644)
		if err != nil {
			return
		}
		logFile = f
		writers = append(writers, &countingWriter{w: f})
	}

	if outputMode == "stdout" || outputMode == "both" {
		writers = append(writers, os.Stdout)
	}

	if len(writers) == 0 {
		return
	}

	var dst io.Writer
	if len(writers) == 1 {
		dst = writers[0]
	} else {
		dst = io.MultiWriter(writers...)
	}

	h := slog.NewJSONHandler(dst, &slog.HandlerOptions{
		Level:       slogLevelTrace,
		ReplaceAttr: schemaReplaceAttr,
	})
	logger = slog.New(h)
}

// rotateLocked implements rename-rotate: the live engine.jsonl is renamed to
// engine.jsonl.1, older generations are shifted (.1→.2, .2→.3, up to
// maxLogFiles), and the logger is reset so the next initLogger() call opens a
// fresh engine.jsonl. Files beyond maxLogFiles are deleted before shifting so
// no OS-level rename error can occur. Must be called with logMu held.
func rotateLocked() {
	if logFile == nil || logDir == "" {
		return
	}
	logPath := filepath.Join(logDir, "engine.jsonl")

	// Shift old generations: .{maxLogFiles-1} → .{maxLogFiles}, …, .1 → .2.
	// Remove the oldest slot first so the rename never fails on a pre-existing file.
	for i := maxLogFiles; i >= 2; i-- {
		older := fmt.Sprintf("%s.%d", logPath, i)
		newer := fmt.Sprintf("%s.%d", logPath, i-1)
		_ = os.Remove(older)
		_ = os.Rename(newer, older)
	}

	// Close the current handle, rename the live file to .1, and let the next
	// initLogger() call open a fresh engine.jsonl.
	_ = logFile.Close()
	logFile = nil
	logger = nil
	_ = os.Rename(logPath, logPath+".1")
	bytesWritten = 0
}

// ErrStr renders an error as a string for a structured log field, nil-safe.
// Interpolated logging (fmt.Sprintf("%v", err)) tolerated a nil error and
// produced "<nil>"; the structured replacement must not call err.Error() on a
// nil error (that panics). Use ErrStr for the "error" field whenever the error
// may be nil at the call site (e.g. an "err != nil || cancelled" branch where
// err can be nil). Returns "" for a nil error so the field is present-but-empty
// rather than a panic.
func ErrStr(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

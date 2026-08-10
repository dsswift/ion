// log.go — the extension's logging channel.
//
// Stdout is the protocol; writing to it directly corrupts the frame stream.
// Every log line therefore travels as a JSON-RPC `log` notification, and the
// engine stamps it component=extension, tag=<extension name> and writes it to
// ~/.ion/engine.jsonl alongside its own lines.
//
// Structured fields stay structured. Never interpolate an identifier into the
// message — pass it in fields, so a log query can filter on it.
package ion

import "sync"

// methodLog is the notification method name for the logging channel.
const methodLog = "log"

// logParams is the wire shape of a log notification. Pinned by the engine's
// notification handler (rpcLogNotification).
type logParams struct {
	Level   string         `json:"level"`
	Message string         `json:"message"`
	Fields  map[string]any `json:"fields,omitempty"`
}

// Logger writes structured lines to the engine's log.
type Logger struct {
	mu   sync.Mutex
	emit func(method string, params any)
}

// Debug logs per-request detail: intermediate values, loop iterations, the
// verbose replay material. Present in production, filtered by level.
func (l *Logger) Debug(message string, fields map[string]any) {
	l.write("debug", message, fields)
}

// Info logs state transitions, resolved decisions, and operation outcomes.
func (l *Logger) Info(message string, fields map[string]any) {
	l.write("info", message, fields)
}

// Warn logs a recoverable problem: a degraded path taken, a fallback used.
func (l *Logger) Warn(message string, fields map[string]any) {
	l.write("warn", message, fields)
}

// Error logs an unexpected failure, a caught panic, or an invariant violation.
func (l *Logger) Error(message string, fields map[string]any) {
	l.write("error", message, fields)
}

func (l *Logger) write(level, message string, fields map[string]any) {
	l.mu.Lock()
	emit := l.emit
	l.mu.Unlock()
	if emit == nil {
		return
	}
	if fields == nil {
		fields = map[string]any{}
	}
	emit(methodLog, logParams{Level: level, Message: message, Fields: fields})
}

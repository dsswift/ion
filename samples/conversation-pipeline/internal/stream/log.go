package stream

import (
	"encoding/json"
	"os"
	"sync/atomic"
	"time"
)

// quiet drops INFO lines when set. The guided demo sets it so the console
// carries the walkthrough and not the housekeeping; WARN and ERROR always
// print, because a demo that hides a failure is worse than a noisy one.
var quiet atomic.Bool

// SetQuiet controls whether INFO log lines are written.
func SetQuiet(on bool) { quiet.Store(on) }

// Logf writes one JSON line to stderr. The sample's containers run with
// stderr and stdout both collected, so nothing is lost there; on a
// terminal it keeps the structured record apart from a command's real
// output (a transcript, a conversation id) so the output stays pipeable.
func Logf(level, msg string, fields map[string]any) {
	if level == "INFO" && quiet.Load() {
		return
	}
	line := map[string]any{"ts": time.Now().UTC().Format(time.RFC3339Nano), "level": level, "msg": msg}
	for k, v := range fields {
		line[k] = v
	}
	b, err := json.Marshal(line)
	if err != nil {
		b = []byte(`{"level":"ERROR","msg":"log line did not marshal"}`)
	}
	os.Stderr.Write(append(b, '\n')) //nolint:errcheck // stderr
}

// EnvOr reads an environment variable with a default.
func EnvOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

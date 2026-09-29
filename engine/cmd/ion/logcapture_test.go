package main

import (
	"fmt"
	"strings"
	"sync"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// captureLogs installs a test sink and returns a function that yields the
// captured lines (tag + message + key fields). It removes the sink on cleanup.
func captureLogs(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var lines []string
	utils.SetTestSink(func(_ utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		mu.Lock()
		line := tag + ": " + msg
		for k, v := range fields {
			line += " " + k + "=" + fmt.Sprint(v)
		}
		lines = append(lines, line)
		mu.Unlock()
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		out := make([]string, len(lines))
		copy(out, lines)
		return out
	}
}

func containsSubstr(lines []string, substr string) bool {
	for _, l := range lines {
		if strings.Contains(l, substr) {
			return true
		}
	}
	return false
}

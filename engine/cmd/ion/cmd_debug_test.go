package main

import (
	"strings"
	"testing"
)

// A bad --seconds is refused before the daemon is contacted.
func TestDebugProfileRejectsBadSeconds(t *testing.T) {
	for _, v := range []string{"0", "-3", "ten"} {
		if _, err := debugProfile("/nonexistent/engine.sock", "cpu", v); err == nil || !strings.Contains(err.Error(), "--seconds") {
			t.Errorf("--seconds %q: err = %v, want a --seconds error", v, err)
		}
	}
}

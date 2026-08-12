package server

import (
	"context"
	"testing"
)

// TestServeContext_MinimalServerUsesBackgroundContext pins dispatch helpers
// used with direct Server fixtures: context.WithCancel must never receive nil.
func TestServeContext_MinimalServerUsesBackgroundContext(t *testing.T) {
	ctx := (&Server{}).serveContext()
	if ctx == nil {
		t.Fatal("minimal server returned nil serve context")
	}
	if err := ctx.Err(); err != nil {
		t.Fatalf("minimal server context error = %v, want active background context", err)
	}

	derived, cancel := context.WithCancel(ctx)
	defer cancel()
	if derived == nil {
		t.Fatal("context.WithCancel returned nil context")
	}
}

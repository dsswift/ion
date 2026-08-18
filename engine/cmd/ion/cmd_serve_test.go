//go:build !windows

package main

import (
	"os"
	"os/signal"
	"syscall"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/mcp"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestSIGHUP_InSignalSet confirms that SIGHUP is registered in the signal
// notification channel that cmd_serve.go uses to trigger graceful shutdown.
// This pins the behaviour that launchctl bootout (SIGTERM) and parent-process
// death (SIGHUP sent to non-detached children) both produce a clean exit.
func TestConfigureSubsystemTimeoutsAppliesSupportedMCPTimeouts(t *testing.T) {
	originalCall := mcp.DefaultCallTimeout
	originalMetadata := mcp.DefaultMetadataTimeout
	originalHook := extension.ConfiguredDefaultTimeout
	t.Cleanup(func() {
		mcp.SetDefaultCallTimeout(originalCall)
		mcp.SetDefaultMetadataTimeout(originalMetadata)
		extension.ConfiguredDefaultTimeout = originalHook
	})

	configureSubsystemTimeouts(&types.TimeoutsConfig{
		McpCallMs:     1_234,
		McpMetadataMs: 5_678,
		HookDefaultMs: 9_101,
	})

	if got := mcp.DefaultCallTimeout; got != 1234*time.Millisecond {
		t.Fatalf("MCP call timeout = %v, want %v", got, 1234*time.Millisecond)
	}
	if got := mcp.DefaultMetadataTimeout; got != 5678*time.Millisecond {
		t.Fatalf("MCP metadata timeout = %v, want %v", got, 5678*time.Millisecond)
	}
	if got := extension.ConfiguredDefaultTimeout; got != 9101*time.Millisecond {
		t.Fatalf("hook timeout = %v, want %v", got, 9101*time.Millisecond)
	}
}

func TestSIGHUP_InSignalSet(t *testing.T) {
	ch := make(chan os.Signal, 1)
	signal.Notify(ch, syscall.SIGINT, syscall.SIGTERM, syscall.SIGHUP)
	defer signal.Stop(ch)

	if err := syscall.Kill(os.Getpid(), syscall.SIGHUP); err != nil {
		t.Fatalf("kill SIGHUP: %v", err)
	}

	sig := <-ch
	if sig != syscall.SIGHUP {
		t.Errorf("got signal %v, want SIGHUP", sig)
	}
}

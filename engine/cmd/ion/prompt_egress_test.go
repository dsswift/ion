package main

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Against an engine it did not start, ion prompt ships nothing of its own.
func TestStartPromptEgressSkipsWhenEngineNotSpawned(t *testing.T) {
	promptEgressActive = false
	startPromptEgress(nil)
	if promptEgressActive {
		t.Fatal("prompt egress started without a spawned engine")
	}
}

// When ion prompt started the engine and egress is configured, it ships its
// own lines through a spool file of its own.
func TestStartPromptEgressUsesItsOwnSpool(t *testing.T) {
	dir := t.TempDir()
	t.Setenv("ION_DATA_DIR", dir)
	t.Setenv("HOME", dir)
	cfg := `{"logging":{"egressTargets":["otel"],"egressOtel":{"enabled":true,"endpoint":"http://127.0.0.1:1"},"egressShipSources":["engine"],"egressFlushIntervalMs":3600000,"egressRequestTimeoutMs":200}}`
	if err := os.WriteFile(filepath.Join(dir, "engine.json"), []byte(cfg), 0o600); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		drainPromptEgress()
		utils.SetEgressSpoolName(".engine-egress-spool.jsonl")
	})

	startPromptEgress(&os.Process{Pid: os.Getpid()})
	if !promptEgressActive {
		t.Fatal("prompt egress did not start")
	}
	utils.LogWithFields(utils.LevelInfo, "test", "prompt-owned line", nil)
	drainPromptEgress()
	if _, err := os.Stat(filepath.Join(dir, ".prompt-egress-spool.jsonl")); err != nil {
		t.Errorf("undeliverable prompt lines did not spool to the prompt's own file: %v", err)
	}
	if _, err := os.Stat(filepath.Join(dir, ".engine-egress-spool.jsonl")); err == nil {
		t.Error("prompt lines spooled into the engine's spool file")
	}
}

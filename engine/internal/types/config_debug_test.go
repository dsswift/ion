package types

import "testing"

func TestDebugConfigPprofListenNilSafe(t *testing.T) {
	var nilCfg *DebugConfig
	if nilCfg.PprofListen() != "" || (&DebugConfig{}).PprofListen() != "" {
		t.Fatal("an unset pprof block must be off")
	}
	if got := (&DebugConfig{Pprof: &PprofConfig{Listen: "127.0.0.1:6060"}}).PprofListen(); got != "127.0.0.1:6060" {
		t.Fatalf("PprofListen = %q", got)
	}
}

// A later layer that names a listen address wins; an empty one leaves the
// earlier value; the inputs are never aliased by the result.
func TestMergeDebugLayers(t *testing.T) {
	base := &DebugConfig{Pprof: &PprofConfig{Listen: "127.0.0.1:6060"}}
	if got := MergeDebug(base, nil); got != base {
		t.Fatal("nil src must return dst unchanged")
	}
	if got := MergeDebug(base, &DebugConfig{Pprof: &PprofConfig{}}); got.PprofListen() != "127.0.0.1:6060" {
		t.Fatalf("empty listen replaced the earlier one: %q", got.PprofListen())
	}
	merged := MergeDebug(base, &DebugConfig{Pprof: &PprofConfig{Listen: "localhost:7070"}})
	if merged.PprofListen() != "localhost:7070" {
		t.Fatalf("later listen = %q, want localhost:7070", merged.PprofListen())
	}
	if base.Pprof.Listen != "127.0.0.1:6060" {
		t.Fatal("merge mutated dst")
	}
	src := &DebugConfig{Pprof: &PprofConfig{Listen: "127.0.0.1:1"}}
	fresh := MergeDebug(nil, src)
	fresh.Pprof.Listen = "changed"
	if src.Pprof.Listen != "127.0.0.1:1" {
		t.Fatal("merge into nil aliased src")
	}
}

package tools

import (
	"context"
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/types"
)

// ctxWithSink returns a context carrying a fresh TouchedPathSink plus the sink
// for assertions.
func ctxWithSink() (context.Context, *types.TouchedPathSink) {
	s := types.NewTouchedPathSink()
	return types.WithTouchedPathSink(context.Background(), s), s
}

// TestTouchedPath_ReadRecordsResolved pins that a successful Read records the
// resolved absolute file_path.
func TestTouchedPath_ReadRecordsResolved(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "a.txt")
	os.WriteFile(fp, []byte("hello"), 0o644)

	ctx, sink := ctxWithSink()
	_, _ = ExecuteTool(ctx, "Read", map[string]any{"file_path": fp}, dir)

	got := sink.DrainAndClear()
	if len(got) != 1 || got[0] != fp {
		t.Fatalf("Read sink = %v, want [%s]", got, fp)
	}
}

// TestTouchedPath_ReadRelativeResolvesAgainstCwd pins that a relative path is
// recorded resolved against cwd.
func TestTouchedPath_ReadRelativeResolvesAgainstCwd(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "rel.txt"), []byte("x"), 0o644)

	ctx, sink := ctxWithSink()
	_, _ = ExecuteTool(ctx, "Read", map[string]any{"file_path": "rel.txt"}, dir)

	got := sink.DrainAndClear()
	want := filepath.Join(dir, "rel.txt")
	if len(got) != 1 || got[0] != want {
		t.Fatalf("Read relative sink = %v, want [%s]", got, want)
	}
}

// TestTouchedPath_WriteEditRecord pins Write and Edit record their resolved
// file_path.
func TestTouchedPath_WriteEditRecord(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "w.txt")

	ctxW, sinkW := ctxWithSink()
	_, _ = ExecuteTool(ctxW, "Write", map[string]any{"file_path": fp, "content": "v1"}, dir)
	if got := sinkW.DrainAndClear(); len(got) != 1 || got[0] != fp {
		t.Fatalf("Write sink = %v, want [%s]", got, fp)
	}

	ctxE, sinkE := ctxWithSink()
	_, _ = ExecuteTool(ctxE, "Edit", map[string]any{"file_path": fp, "old_string": "v1", "new_string": "v2"}, dir)
	if got := sinkE.DrainAndClear(); len(got) != 1 || got[0] != fp {
		t.Fatalf("Edit sink = %v, want [%s]", got, fp)
	}
}

// TestTouchedPath_GrepGlobRecordPath pins Grep records the resolved search path
// and Glob records the resolved search dir.
func TestTouchedPath_GrepGlobRecordPath(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "sub")
	os.MkdirAll(sub, 0o755)
	os.WriteFile(filepath.Join(sub, "x.go"), []byte("package sub"), 0o644)

	ctxG, sinkG := ctxWithSink()
	_, _ = ExecuteTool(ctxG, "Grep", map[string]any{"pattern": "package", "path": "sub"}, dir)
	if got := sinkG.DrainAndClear(); len(got) != 1 || got[0] != sub {
		t.Fatalf("Grep sink = %v, want [%s]", got, sub)
	}

	ctxGl, sinkGl := ctxWithSink()
	_, _ = ExecuteTool(ctxGl, "Glob", map[string]any{"pattern": "*.go", "path": sub}, dir)
	if got := sinkGl.DrainAndClear(); len(got) != 1 || got[0] != sub {
		t.Fatalf("Glob sink = %v, want [%s]", got, sub)
	}
}

// TestTouchedPath_NotebookRecords pins Notebook records its resolved path.
func TestTouchedPath_NotebookRecords(t *testing.T) {
	dir := t.TempDir()
	nb := filepath.Join(dir, "n.ipynb")
	os.WriteFile(nb, []byte(`{"cells":[],"metadata":{},"nbformat":4,"nbformat_minor":5}`), 0o644)

	ctx, sink := ctxWithSink()
	_, _ = ExecuteTool(ctx, "NotebookEdit", map[string]any{"action": "read", "path": nb}, dir)
	if got := sink.DrainAndClear(); len(got) != 1 || got[0] != nb {
		t.Fatalf("NotebookEdit sink = %v, want [%s]", got, nb)
	}
}

// TestTouchedPath_NonPathToolsRecordNothing pins that Bash and WebFetch record
// nothing (no local file path).
func TestTouchedPath_NonPathToolsRecordNothing(t *testing.T) {
	dir := t.TempDir()

	ctxB, sinkB := ctxWithSink()
	_, _ = ExecuteTool(ctxB, "Bash", map[string]any{"command": "echo hi"}, dir)
	if got := sinkB.DrainAndClear(); got != nil {
		t.Errorf("Bash should record nothing, got %v", got)
	}

	ctxW, sinkW := ctxWithSink()
	_, _ = ExecuteTool(ctxW, "WebFetch", map[string]any{"url": "not-a-url"}, dir)
	if got := sinkW.DrainAndClear(); got != nil {
		t.Errorf("WebFetch should record nothing, got %v", got)
	}
}

// TestTouchedPath_EmptyAndFailedRecordNothing pins that an empty or missing
// path records nothing (the empty-path guard fires before resolution).
func TestTouchedPath_EmptyAndFailedRecordNothing(t *testing.T) {
	dir := t.TempDir()

	ctx, sink := ctxWithSink()
	// Read with no file_path → error, records nothing.
	_, _ = ExecuteTool(ctx, "Read", map[string]any{}, dir)
	if got := sink.DrainAndClear(); got != nil {
		t.Errorf("Read with empty file_path should record nothing, got %v", got)
	}

	// Grep with no path → records nothing (empty path is not recorded).
	ctx2, sink2 := ctxWithSink()
	_, _ = ExecuteTool(ctx2, "Grep", map[string]any{"pattern": "x"}, dir)
	if got := sink2.DrainAndClear(); got != nil {
		t.Errorf("Grep with empty path should record nothing, got %v", got)
	}
}

// TestTouchedPath_NoSinkInstalled pins that tools run normally when no sink is
// on the context (the common path for direct callers / sub-flows).
func TestTouchedPath_NoSinkInstalled(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "a.txt")
	os.WriteFile(fp, []byte("hello"), 0o644)
	// No sink in ctx — must not panic.
	res, err := ExecuteTool(context.Background(), "Read", map[string]any{"file_path": fp}, dir)
	if err != nil {
		t.Fatalf("Read without sink errored: %v", err)
	}
	if res == nil || res.IsError {
		t.Fatalf("Read without sink failed: %+v", res)
	}
}

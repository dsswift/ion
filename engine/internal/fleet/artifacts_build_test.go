package fleet

import (
	"context"
	"io"
	"os"
	"path/filepath"
	"testing"
	"time"
)

// A file system can store a file's time more coarsely than the clock, so a
// package the build just wrote may carry a time before the build started.
// It is still the new package; an untouched older one never is.
func TestBuildDesktop_FindsTheWrittenPackageWhateverItsTime(t *testing.T) {
	checkout := t.TempDir()
	release := filepath.Join(checkout, "desktop", "release")
	old := filepath.Join(release, "Ion-1.0.0.pkg")
	if err := writeEmpty(old); err != nil {
		t.Fatal(err)
	}
	past := time.Now().Add(-time.Hour)
	if err := os.Chtimes(old, past, past); err != nil {
		t.Fatal(err)
	}
	built := filepath.Join(release, "Ion-2.0.0.pkg")
	a := &Artifacts{Exec: func(context.Context, ExecSpec) error {
		if err := writeEmpty(built); err != nil {
			return err
		}
		coarse := time.Now().Add(-time.Second)
		return os.Chtimes(built, coarse, coarse)
	}}
	got, err := a.BuildDesktop(context.Background(), checkout, io.Discard)
	if err != nil || got != built {
		t.Fatalf("got %q, %v; want %s", got, err, built)
	}

	a.Exec = func(context.Context, ExecSpec) error { return nil }
	if got, err := a.BuildDesktop(context.Background(), checkout, io.Discard); err == nil {
		t.Fatalf("a build that wrote nothing returned %q", got)
	}
}

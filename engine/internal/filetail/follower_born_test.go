package filetail

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

// A file that did not exist when the follower started has no history, so
// StartAtEnd reads it from its first line. An ephemeral engine creates its
// telemetry file mid-run; skipping to its end lost every event.
func TestFollowerStartAtEndReadsFileBornAfterStart(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "telemetry.jsonl")
	f := New(path, Options{Start: StartAtEnd})
	defer func() { _ = f.Close() }()

	var got []string
	collect := func(line []byte) error { got = append(got, string(line)); return nil }
	if err := f.Poll(collect); !errors.Is(err, os.ErrNotExist) {
		t.Fatalf("first poll error = %v, want not-exist", err)
	}
	if err := os.WriteFile(path, []byte("first\nsecond\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := f.Poll(collect); err != nil {
		t.Fatal(err)
	}
	if want := []string{"first", "second"}; !sameStrings(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}
}

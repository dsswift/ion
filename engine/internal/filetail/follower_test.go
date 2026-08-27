package filetail

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestFollowerStartModesAndPartialLines(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(path, []byte("history\npartial"), 0o600); err != nil {
		t.Fatal(err)
	}

	atEnd := New(path, Options{Start: StartAtEnd})
	defer func() { _ = atEnd.Close() }()
	var got []string
	if err := atEnd.Poll(func(line []byte) error { got = append(got, string(line)); return nil }); err != nil {
		t.Fatal(err)
	}
	if len(got) != 0 {
		t.Fatalf("StartAtEnd delivered %v", got)
	}
	if err := os.WriteFile(path, []byte("history\npartial\nnext\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := atEnd.Poll(func(line []byte) error { got = append(got, string(line)); return nil }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"partial", "next"}; !sameStrings(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}

	atBeginning := New(path, Options{Start: StartAtBeginning})
	defer func() { _ = atBeginning.Close() }()
	got = nil
	if err := atBeginning.Poll(func(line []byte) error { got = append(got, string(line)); return nil }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"history", "partial", "next"}; !sameStrings(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}
}

func TestFollowerAcknowledgementAndPastEOFClamp(t *testing.T) {
	t.Parallel()
	path := filepath.Join(t.TempDir(), "events.jsonl")
	if err := os.WriteFile(path, []byte("one\ntwo\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	follower := New(path, Options{Cursor: Cursor{Offset: 99, Initialized: true}})
	defer func() { _ = follower.Close() }()
	var got []string
	fail := true
	err := follower.Poll(func(line []byte) error {
		got = append(got, string(line))
		if fail {
			return errors.New("reject")
		}
		return nil
	})
	if err == nil {
		t.Fatal("Poll succeeded after rejected line")
	}
	if follower.Cursor().Offset != 0 {
		t.Fatalf("cursor advanced after reject: %d", follower.Cursor().Offset)
	}
	fail = false
	if err := follower.Poll(func(line []byte) error { got = append(got, string(line)); return nil }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"one", "one", "two"}; !sameStrings(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}
}

func TestFollowerDrainsRenamedFileBeforeReplacement(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	path := filepath.Join(dir, "events.jsonl")
	oldPath := filepath.Join(dir, "events.jsonl.1")
	if err := os.WriteFile(path, nil, 0o600); err != nil {
		t.Fatal(err)
	}
	follower := New(path, Options{Start: StartAtEnd})
	defer func() { _ = follower.Close() }()
	if err := follower.Poll(func([]byte) error { return nil }); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(path, oldPath); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(oldPath, []byte("old\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("new\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	var got []string
	if err := follower.Poll(func(line []byte) error { got = append(got, string(line)); return nil }); err != nil {
		t.Fatal(err)
	}
	if want := []string{"old", "new"}; !sameStrings(got, want) {
		t.Fatalf("lines = %v, want %v", got, want)
	}
}

func sameStrings(got, want []string) bool {
	if len(got) != len(want) {
		return false
	}
	for index := range got {
		if got[index] != want[index] {
			return false
		}
	}
	return true
}

//go:build !windows

package procres

import (
	"context"
	"net"
	"os"
	"path/filepath"
	"syscall"
	"testing"
)

// The count must be real on every unix platform: an Unknown here is what let
// descriptor growth go unobserved. It must also hold while the process owns a
// socket, which a full directory read of the descriptor directory cannot stat.
func TestReadDescriptorsCountsOpenFiles(t *testing.T) {
	dir, err := os.MkdirTemp("", "pr")
	if err != nil {
		t.Fatal(err)
	}
	defer os.RemoveAll(dir) //nolint:errcheck // test cleanup
	ln, err := net.Listen("unix", filepath.Join(dir, "s"))
	if err != nil {
		t.Fatal(err)
	}
	defer ln.Close() //nolint:errcheck // test cleanup

	before := ReadDescriptors()
	if before.Open < 3 {
		t.Fatalf("Open = %d, want at least the three standard streams", before.Open)
	}
	if before.Limit == Unknown || before.Limit < int64(before.Open) {
		t.Fatalf("Limit = %d, want a finite limit at or above Open (%d)", before.Limit, before.Open)
	}

	const n = 5
	files := make([]*os.File, 0, n)
	for i := 0; i < n; i++ {
		f, err := os.Open(os.DevNull)
		if err != nil {
			t.Fatal(err)
		}
		files = append(files, f)
	}
	during := ReadDescriptors()
	for _, f := range files {
		f.Close() //nolint:errcheck // test cleanup
	}
	if d, ok := during.Delta(before); !ok || d != n {
		t.Errorf("Delta after opening %d files = %d, %v", n, d, ok)
	}
}

func TestProbeSpawnSucceedsWithHeadroom(t *testing.T) {
	if err := ProbeSpawn(context.Background()); err != nil {
		t.Fatalf("ProbeSpawn = %v, want nil", err)
	}
}

// Drive the process to a real EMFILE and confirm the probe reports it as
// descriptor exhaustion, then recovers once descriptors are released.
func TestProbeSpawnReportsDescriptorExhaustion(t *testing.T) {
	var orig syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &orig); err != nil {
		t.Fatal(err)
	}
	lowered := orig
	lowered.Cur = uint64(ReadDescriptors().Open + 64)
	if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &lowered); err != nil {
		t.Skipf("cannot lower RLIMIT_NOFILE: %v", err)
	}
	restore := func() {
		if err := syscall.Setrlimit(syscall.RLIMIT_NOFILE, &orig); err != nil {
			t.Errorf("restore RLIMIT_NOFILE: %v", err)
		}
	}

	var held []*os.File
	for {
		f, err := os.Open(os.DevNull)
		if err != nil {
			break
		}
		held = append(held, f)
	}
	err := ProbeSpawn(context.Background())
	for _, f := range held {
		f.Close() //nolint:errcheck // test cleanup
	}
	restore()

	resource, ok := ExhaustedResource(err)
	if !ok || resource != ResourceFileDescriptors {
		t.Fatalf("ProbeSpawn at the descriptor limit = %v; classified %q, %v", err, resource, ok)
	}
	if err := ProbeSpawn(context.Background()); err != nil {
		t.Fatalf("ProbeSpawn after release = %v, want nil", err)
	}
}

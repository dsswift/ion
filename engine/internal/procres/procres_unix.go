//go:build !windows

package procres

import (
	"bytes"
	"context"
	"os"
	"os/exec"
	"syscall"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// probeTimeout bounds one spawn probe.
const probeTimeout = 10 * time.Second

// ReadDescriptors reads the process's descriptor count and limit.
func ReadDescriptors() Descriptors {
	return Descriptors{Open: countOpen(), Limit: descriptorLimit()}
}

// countOpen lists the per-process descriptor directory. It reads names only:
// a full directory read stats every entry, and one descriptor that cannot be
// stat'ed fails the whole listing.
func countOpen() int {
	for _, dir := range []string{"/proc/self/fd", "/dev/fd"} {
		f, err := os.Open(dir)
		if err != nil {
			continue
		}
		names, err := f.Readdirnames(-1)
		f.Close() //nolint:errcheck // read-only directory handle; nothing to flush
		if err != nil {
			continue
		}
		// The listing counts the handle used to read it.
		return len(names) - 1
	}
	return Unknown
}

// descriptorLimit returns the soft RLIMIT_NOFILE, lowered to the platform's
// per-process ceiling where one applies.
func descriptorLimit() int64 {
	var rl syscall.Rlimit
	if err := syscall.Getrlimit(syscall.RLIMIT_NOFILE, &rl); err != nil {
		return Unknown
	}
	// An unlimited soft limit is the largest value the field can hold.
	limit := int64(Unknown)
	if cur := uint64(rl.Cur); cur <= 1<<62 {
		limit = int64(cur)
	}
	if ceiling := platformDescriptorCeiling(); ceiling != Unknown && (limit == Unknown || ceiling < limit) {
		limit = ceiling
	}
	return limit
}

// ProbeSpawn starts and reaps one no-op shell with all three standard streams
// piped, the same descriptors and process slot any subprocess start needs. A
// nil return means the process can still start a subprocess. Classify a
// non-nil return with ExhaustedResource.
func ProbeSpawn(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, probeTimeout)
	defer cancel()

	shell, args, _ := (*types.ShellConfig)(nil).Resolve("exit 0")
	cmd := exec.CommandContext(ctx, shell, args...)
	var out bytes.Buffer
	cmd.Stdout = &out
	cmd.Stderr = &out
	stdin, err := cmd.StdinPipe()
	if err != nil {
		return err
	}
	if err := cmd.Start(); err != nil {
		stdin.Close() //nolint:errcheck // the start failure is the reported error
		return err
	}
	stdin.Close() //nolint:errcheck // closing our end only signals EOF to the probe
	return cmd.Wait()
}

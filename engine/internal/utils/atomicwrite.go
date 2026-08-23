package utils

import (
	"fmt"
	"os"
	"path/filepath"
)

// AtomicWriteFile writes data to path atomically: write to a unique sibling,
// fsync data, rename over target, then fsync parent directory. On any failure
// temp file is cleaned up and original remains untouched.
func AtomicWriteFile(path string, data []byte, perm os.FileMode) error {
	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("atomic write mkdir %s: %w", dir, err)
	}

	tmp, err := os.CreateTemp(dir, ".ion-atomic-*")
	if err != nil {
		return fmt.Errorf("atomic write create temp: %w", err)
	}
	tmpPath := tmp.Name()
	cleanup := func() { _ = os.Remove(tmpPath) } //nolint:errcheck // best-effort failed-write cleanup
	if err := tmp.Chmod(perm); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("atomic write chmod: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("atomic write write: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close() //nolint:errcheck // best-effort before cleanup
		cleanup()
		return fmt.Errorf("atomic write sync: %w", err)
	}
	if err := tmp.Close(); err != nil {
		cleanup()
		return fmt.Errorf("atomic write close: %w", err)
	}
	if err := os.Rename(tmpPath, path); err != nil {
		cleanup()
		return fmt.Errorf("atomic write rename %s -> %s: %w", tmpPath, path, err)
	}

	if dirHandle, err := os.Open(dir); err == nil {
		dirHandle.Sync()  //nolint:errcheck // best-effort directory durability
		dirHandle.Close() //nolint:errcheck // best-effort directory close
	}
	return nil
}

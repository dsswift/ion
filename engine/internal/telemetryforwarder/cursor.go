package telemetryforwarder

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/filetail"
)

func loadCursor(path string) (filetail.Cursor, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return filetail.Cursor{}, nil
	}
	if err != nil {
		return filetail.Cursor{}, fmt.Errorf("telemetry forwarder: read cursor: %w", err)
	}
	var cursor filetail.Cursor
	if err := json.Unmarshal(data, &cursor); err != nil {
		return filetail.Cursor{}, fmt.Errorf("telemetry forwarder: decode cursor: %w", err)
	}
	return cursor, nil
}

func saveCursor(path string, cursor filetail.Cursor) error {
	data, err := json.Marshal(cursor)
	if err != nil {
		return fmt.Errorf("telemetry forwarder: encode cursor: %w", err)
	}
	directory := filepath.Dir(path)
	if err := os.MkdirAll(directory, 0o700); err != nil {
		return fmt.Errorf("telemetry forwarder: create cursor directory: %w", err)
	}
	temporary, err := os.CreateTemp(directory, ".telemetry-forwarder-cursor-*")
	if err != nil {
		return fmt.Errorf("telemetry forwarder: create cursor: %w", err)
	}
	temporaryPath := temporary.Name()
	defer func() {
		if err := os.Remove(temporaryPath); err != nil && !errors.Is(err, os.ErrNotExist) {
			return
		}
	}()
	if err := temporary.Chmod(0o600); err != nil {
		return fmt.Errorf("telemetry forwarder: set cursor permissions: %w", err)
	}
	if _, err := temporary.Write(data); err != nil {
		return fmt.Errorf("telemetry forwarder: write cursor: %w", err)
	}
	if err := temporary.Sync(); err != nil {
		return fmt.Errorf("telemetry forwarder: sync cursor: %w", err)
	}
	if err := temporary.Close(); err != nil {
		return fmt.Errorf("telemetry forwarder: close cursor: %w", err)
	}
	if err := os.Rename(temporaryPath, path); err != nil {
		return fmt.Errorf("telemetry forwarder: replace cursor: %w", err)
	}
	return nil
}

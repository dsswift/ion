package config

// backend_default.go — fill engine.json's top-level backend when it is unset.

import (
	"fmt"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SetBackendIfUnset writes backend as engine.json's top-level "backend" when
// the file has none (absent or empty). An explicit value is never overridden.
// It edits the raw map, so every other key survives. Returns whether it wrote
// and the value found (empty when unset). It returns a
// ManagedConfigWriteError, writing nothing, when the managed source owns the
// engine configuration.
func SetBackendIfUnset(path, backend string) (bool, string, error) {
	wrote := false
	existing := ""
	if err := RefuseManagedConfigWrite(ManagedSurfaceEngine, "set_backend_default"); err != nil {
		return false, "", err
	}
	err := durablefile.Transaction(path, 5*time.Second, func(_ string) error {
		raw, err := readRawConfig(path)
		if err != nil {
			return err
		}
		if current, present := raw["backend"]; present && current != "" {
			value, isString := current.(string)
			if !isString {
				return fmt.Errorf("backend in %s is %T, not a string; fix it by hand", path, current)
			}
			existing = value
			utils.LogWithFields(utils.LevelInfo, "config", "engine backend already set; kept", map[string]any{"path": path, "backend": value})
			return nil
		}
		raw["backend"] = backend
		if err := writeRawConfig(path, raw); err != nil {
			return err
		}
		wrote = true
		utils.LogWithFields(utils.LevelInfo, "config", "engine backend was unset; wrote default", map[string]any{"path": path, "backend": backend})
		return nil
	})
	return wrote, existing, err
}

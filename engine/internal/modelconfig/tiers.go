package modelconfig

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/filelock"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Default tier mappings. Empty by design: the engine ships no model opinions.
var defaultTiers = map[string]string{}

// ListTiers returns the complete configured tier snapshot in stable name order.
// Legacy string values and object values share one normalized wire shape.
func ListTiers() []types.ModelTierEntry {
	config := LoadModelsConfig()
	tiers, ok := config["tiers"].(map[string]interface{})
	if !ok {
		return []types.ModelTierEntry{}
	}
	entries := make([]types.ModelTierEntry, 0, len(tiers))
	for name, raw := range tiers {
		entry, ok := parseTier(name, raw)
		if ok {
			entries = append(entries, entry)
		}
	}
	sort.Slice(entries, func(i, j int) bool { return entries[i].Name < entries[j].Name })
	return entries
}

// SetTier validates and atomically persists one tier. Names are normalized to
// lowercase because tier lookup is case-insensitive.
func SetTier(name, model string, fallbacks []string) (types.ModelTierEntry, error) {
	entry, err := newTierEntry(name, model, fallbacks)
	if err != nil {
		return types.ModelTierEntry{}, err
	}
	err = withModelsConfig(func(config map[string]interface{}) error {
		tiers, ok := config["tiers"].(map[string]interface{})
		if !ok {
			tiers = make(map[string]interface{})
			config["tiers"] = tiers
		}
		// Keep no-fallback tiers in the compact legacy string form. Existing
		// hand-written files stay idiomatic, while non-empty chains retain their
		// explicit ordered object representation.
		if len(entry.Fallbacks) == 0 {
			tiers[entry.Name] = entry.Model
		} else {
			tiers[entry.Name] = map[string]interface{}{"model": entry.Model, "fallbacks": entry.Fallbacks}
		}
		return writeModelsConfigAtomic(modelsConfigPath(), config)
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "modelconfig.tiers", "model tier write failed", map[string]any{"tier": entry.Name, "model": entry.Model, "fallback_count": len(entry.Fallbacks), "error": err.Error()})
		return types.ModelTierEntry{}, err
	}
	utils.LogWithFields(utils.LevelInfo, "modelconfig.tiers", "model tier written", map[string]any{"tier": entry.Name, "model": entry.Model, "fallback_count": len(entry.Fallbacks)})
	return entry, nil
}

// RemoveTier atomically deletes one configured tier. It returns false when no
// such tier exists, allowing callers to report a precise refusal.
func RemoveTier(name string) (bool, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return false, fmt.Errorf("model tier name is required")
	}
	removed := false
	err := withModelsConfig(func(config map[string]interface{}) error {
		tiers, ok := config["tiers"].(map[string]interface{})
		if !ok {
			return nil
		}
		if _, exists := tiers[name]; !exists {
			return nil
		}
		delete(tiers, name)
		removed = true
		return writeModelsConfigAtomic(modelsConfigPath(), config)
	})
	if err != nil {
		utils.LogWithFields(utils.LevelError, "modelconfig.tiers", "model tier removal failed", map[string]any{"tier": name, "error": err.Error()})
		return removed, err
	}
	utils.LogWithFields(utils.LevelInfo, "modelconfig.tiers", "model tier removal completed", map[string]any{"tier": name, "removed": removed})
	return removed, nil
}

// ResolveTier maps a tier name to a concrete model identifier.
func ResolveTier(tierName string) string {
	model, _ := ResolveTierChain(tierName)
	return model
}

// ResolveTierChain returns primary model plus ordered fallback chain. Unknown
// names pass through unchanged so direct model IDs keep working.
func ResolveTierChain(tierName string) (string, []string) {
	if entry, ok := LookupTier(tierName); ok {
		return entry.Model, entry.Fallbacks
	}
	if model, ok := defaultTiers[strings.ToLower(tierName)]; ok {
		return model, nil
	}
	return tierName, nil
}

// LookupTier reports whether a tier is configured and returns its normalized
// representation. Unlike ResolveTierChain, it never treats an arbitrary model
// identifier as a tier.
func LookupTier(name string) (types.ModelTierEntry, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	config := LoadModelsConfig()
	tiers, ok := config["tiers"].(map[string]interface{})
	if !ok {
		return types.ModelTierEntry{}, false
	}
	return parseTier(name, tiers[name])
}

func parseTier(name string, raw interface{}) (types.ModelTierEntry, bool) {
	name = strings.ToLower(strings.TrimSpace(name))
	if name == "" {
		return types.ModelTierEntry{}, false
	}
	switch value := raw.(type) {
	case string:
		entry, err := newTierEntry(name, value, nil)
		return entry, err == nil
	case map[string]interface{}:
		model, ok := value["model"].(string)
		if !ok {
			return types.ModelTierEntry{}, false
		}
		fallbacks := stringsFromRaw(value["fallbacks"])
		entry, err := newTierEntry(name, model, fallbacks)
		return entry, err == nil
	default:
		return types.ModelTierEntry{}, false
	}
}

func newTierEntry(name, model string, fallbacks []string) (types.ModelTierEntry, error) {
	name = strings.ToLower(strings.TrimSpace(name))
	model = strings.TrimSpace(model)
	if name == "" {
		return types.ModelTierEntry{}, fmt.Errorf("model tier name is required")
	}
	if model == "" {
		return types.ModelTierEntry{}, fmt.Errorf("model tier model is required")
	}
	cleanFallbacks := make([]string, 0, len(fallbacks))
	seen := map[string]bool{model: true}
	for _, fallback := range fallbacks {
		fallback = strings.TrimSpace(fallback)
		if fallback == "" {
			return types.ModelTierEntry{}, fmt.Errorf("model tier fallbacks must not contain empty models")
		}
		if seen[fallback] {
			return types.ModelTierEntry{}, fmt.Errorf("model tier fallbacks must be distinct and cannot repeat the primary model")
		}
		seen[fallback] = true
		cleanFallbacks = append(cleanFallbacks, fallback)
	}
	return types.ModelTierEntry{Name: name, Model: model, Fallbacks: cleanFallbacks}, nil
}

func stringsFromRaw(raw interface{}) []string {
	items, ok := raw.([]interface{})
	if !ok {
		return []string{}
	}
	result := make([]string, 0, len(items))
	for _, item := range items {
		if value, ok := item.(string); ok && strings.TrimSpace(value) != "" {
			result = append(result, value)
		}
	}
	return result
}

func modelsConfigPath() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	return filepath.Join(home, ".ion", "models.json")
}

func withModelsConfig(fn func(map[string]interface{}) error) error {
	path := modelsConfigPath()
	if path == "" {
		return fmt.Errorf("resolve home directory")
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return fmt.Errorf("create model config directory: %w", err)
	}
	return filelock.WithLock(path, func() error {
		config, err := loadModelsConfigErr()
		if err != nil {
			return err
		}
		return fn(config)
	})
}

func writeModelsConfigAtomic(path string, config map[string]interface{}) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("marshal model config: %w", err)
	}
	data = append(data, '\n')
	tmp, err := os.CreateTemp(filepath.Dir(path), ".models.json-*")
	if err != nil {
		return fmt.Errorf("create model config temp file: %w", err)
	}
	tmpName := tmp.Name()
	if err := tmp.Chmod(0o600); err != nil {
		tmp.Close()        //nolint:errcheck // cleanup after chmod failure
		os.Remove(tmpName) //nolint:errcheck // cleanup after chmod failure
		return fmt.Errorf("set model config permissions: %w", err)
	}
	if _, err := tmp.Write(data); err != nil {
		tmp.Close()        //nolint:errcheck // cleanup after write failure
		os.Remove(tmpName) //nolint:errcheck // cleanup after write failure
		return fmt.Errorf("write model config: %w", err)
	}
	if err := tmp.Sync(); err != nil {
		tmp.Close()        //nolint:errcheck // cleanup after sync failure
		os.Remove(tmpName) //nolint:errcheck // cleanup after sync failure
		return fmt.Errorf("sync model config: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpName) //nolint:errcheck // cleanup after close failure
		return fmt.Errorf("close model config: %w", err)
	}
	if err := os.Rename(tmpName, path); err != nil {
		os.Remove(tmpName) //nolint:errcheck // cleanup after rename failure
		return fmt.Errorf("replace model config: %w", err)
	}
	return nil
}

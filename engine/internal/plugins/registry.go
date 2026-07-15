package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// InstalledPlugin is one entry in the registry.
type InstalledPlugin struct {
	Name        string    `json:"name"`
	Source      string    `json:"source"`      // "JuliusBrussee/caveman"
	InstallPath string    `json:"installPath"` // absolute path to plugin dir
	Version     string    `json:"version"`     // git sha
	InstalledAt time.Time `json:"installedAt"`
}

type registry struct {
	Plugins []InstalledPlugin `json:"plugins"`
}

// registryPathOverride is used by tests to redirect the registry file to a
// temporary directory. Empty string means "use the default ~/.ion path".
var registryPathOverride string

// RegistryPath returns the path to the installed_plugins.json registry file.
// Tests may override this via the registryPathOverride package-level variable.
func RegistryPath() string {
	if registryPathOverride != "" {
		return registryPathOverride
	}
	home, _ := os.UserHomeDir()
	return filepath.Join(home, ".ion", "plugins", "installed_plugins.json")
}

// ListInstalled returns all registered plugins.
func ListInstalled() ([]InstalledPlugin, error) {
	r, err := readRegistry()
	if err != nil {
		return nil, err
	}
	return r.Plugins, nil
}

// Register adds or replaces a plugin in the registry.
func Register(p InstalledPlugin) error {
	r, err := readRegistry()
	if err != nil {
		return err
	}
	// Replace if same name+source exists.
	replaced := false
	for i, existing := range r.Plugins {
		if existing.Name == p.Name && existing.Source == p.Source {
			r.Plugins[i] = p
			replaced = true
			break
		}
	}
	if !replaced {
		r.Plugins = append(r.Plugins, p)
	}
	return writeRegistry(r)
}

// Unregister removes a plugin by name. Returns error if not found.
func Unregister(name string) error {
	r, err := readRegistry()
	if err != nil {
		return err
	}
	var filtered []InstalledPlugin
	found := false
	for _, p := range r.Plugins {
		if p.Name == name {
			found = true
		} else {
			filtered = append(filtered, p)
		}
	}
	if !found {
		return fmt.Errorf("plugin %q not found", name)
	}
	r.Plugins = filtered
	return writeRegistry(r)
}

func readRegistry() (registry, error) {
	path := RegistryPath()
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return registry{}, nil
		}
		return registry{}, fmt.Errorf("read plugin registry: %w", err)
	}
	var r registry
	if err := json.Unmarshal(data, &r); err != nil {
		return registry{}, fmt.Errorf("parse plugin registry: %w", err)
	}
	return r, nil
}

func writeRegistry(r registry) error {
	path := RegistryPath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return fmt.Errorf("create plugin dir: %w", err)
	}
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(path, data, 0o644)
}

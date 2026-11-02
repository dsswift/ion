package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// InstalledPlugin is one entry in the registry.
type InstalledPlugin struct {
	Name   string `json:"name"`
	Source string `json:"source"` // the Source ID: "owner/repo" on GitHub, "host/path" elsewhere
	// URL is the git remote it was fetched from, which an update fetches
	// again. Empty on a plugin installed before Ion fetched with git.
	URL string `json:"url,omitempty"`
	// Plugin is the marketplace entry asked for at install; empty for a
	// repository's own plugin.
	Plugin      string `json:"plugin,omitempty"`
	InstallPath string `json:"installPath"` // absolute path to the plugin dir
	// CheckoutPath is the fetched repository the plugin dir sits in, which a
	// marketplace may share among several plugins.
	CheckoutPath string    `json:"checkoutPath,omitempty"`
	Version      string    `json:"version"` // git sha
	InstalledAt  time.Time `json:"installedAt"`
}

// root is the directory the plugin's files were fetched into.
func (p InstalledPlugin) root() string {
	if p.CheckoutPath != "" {
		return p.CheckoutPath
	}
	return p.InstallPath
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
	return filepath.Join(utils.IonDir(), "plugins", "installed_plugins.json")
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
	data, err := json.MarshalIndent(r, "", "  ")
	if err != nil {
		return err
	}
	return utils.AtomicWriteFile(path, data, 0o644)
}

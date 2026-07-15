package plugins

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"time"
)

// PluginHookEntry is one command hook within a hook event group.
type PluginHookEntry struct {
	Type          string `json:"type"`    // "command"
	Command       string `json:"command"` // may contain ${CLAUDE_PLUGIN_ROOT}
	Timeout       int    `json:"timeout"` // seconds; 0 → default 30s
	StatusMessage string `json:"statusMessage,omitempty"`
}

// PluginHookGroup is a matcher+hooks pair (matches Claude Code schema).
type PluginHookGroup struct {
	Hooks []PluginHookEntry `json:"hooks"`
}

// PluginManifest is the parsed .claude-plugin/plugin.json.
type PluginManifest struct {
	Name        string                       `json:"name"`
	Description string                       `json:"description,omitempty"`
	Author      map[string]string            `json:"author,omitempty"`
	Hooks       map[string][]PluginHookGroup `json:"hooks,omitempty"`
}

// LoadManifest reads <pluginDir>/.claude-plugin/plugin.json.
// Returns (nil, nil) when the file does not exist.
func LoadManifest(pluginDir string) (*PluginManifest, error) {
	path := filepath.Join(pluginDir, ".claude-plugin", "plugin.json")
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return nil, nil
		}
		return nil, fmt.Errorf("read %s: %w", path, err)
	}
	var m PluginManifest
	if err := json.Unmarshal(data, &m); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	return &m, nil
}

// SessionStartCommands returns all hook commands for the SessionStart event.
func (m *PluginManifest) SessionStartCommands() []PluginHookEntry {
	return m.hookCommands("SessionStart")
}

// UserPromptSubmitCommands returns all hook commands for the UserPromptSubmit event.
func (m *PluginManifest) UserPromptSubmitCommands() []PluginHookEntry {
	return m.hookCommands("UserPromptSubmit")
}

func (m *PluginManifest) hookCommands(event string) []PluginHookEntry {
	groups := m.Hooks[event]
	var out []PluginHookEntry
	for _, g := range groups {
		out = append(out, g.Hooks...)
	}
	return out
}

// EffectiveTimeout returns the hook's timeout as a Duration.
// 0 or negative → 30 seconds (Claude Code's default).
func (e PluginHookEntry) EffectiveTimeout() time.Duration {
	if e.Timeout > 0 {
		return time.Duration(e.Timeout) * time.Second
	}
	return 30 * time.Second
}

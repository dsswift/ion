package extension

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const (
	// MaxPayloadBytes is the maximum size of the JSON payload passed to hooks via ION_EVENT.
	MaxPayloadBytes = 1024 * 1024 // 1MB

	// DefaultTimeout is the default timeout for external hook execution.
	DefaultTimeout = 30 * time.Second
)

// ExternalHookConfig defines a shell command triggered by an engine event.
type ExternalHookConfig struct {
	Command []string      `json:"command"`
	Await   bool          `json:"await"`
	Timeout time.Duration `json:"timeout"`
}

// ExternalHookManager fires shell commands on engine events.
type ExternalHookManager struct {
	mu       sync.RWMutex
	registry map[string][]ExternalHookConfig
}

// NewExternalHookManager creates a hook manager from raw config.
// Config shape: { "event_name": [ ["cmd","arg"] | {"command":[...],"await":bool,"timeout":int_ms} ] }
func NewExternalHookManager(config map[string]interface{}) *ExternalHookManager {
	m := &ExternalHookManager{
		registry: make(map[string][]ExternalHookConfig),
	}
	if config != nil {
		m.parseConfig(config)
	}
	return m
}

// parseConfig populates the registry from raw configuration.
func (m *ExternalHookManager) parseConfig(config map[string]interface{}) {
	m.mu.Lock()
	defer m.mu.Unlock()

	m.registry = make(map[string][]ExternalHookConfig)

	for event, val := range config {
		hooks, ok := val.([]interface{})
		if !ok {
			continue
		}
		for _, entry := range hooks {
			cfg := m.parseHookEntry(entry)
			if cfg != nil {
				m.registry[event] = append(m.registry[event], *cfg)
			}
		}
	}
}

// parseHookEntry parses a single hook entry. Supports two formats:
//   - Array format: ["cmd", "arg1", "arg2"] (fire-and-forget, default timeout)
//   - Object format: {"command": ["cmd","arg"], "await": true, "timeout": 5000}
func (m *ExternalHookManager) parseHookEntry(entry interface{}) *ExternalHookConfig {
	switch v := entry.(type) {
	case []interface{}:
		// Array format: command only, fire-and-forget
		cmd := toStringSlice(v)
		if len(cmd) == 0 {
			return nil
		}
		return &ExternalHookConfig{
			Command: cmd,
			Await:   false,
			Timeout: DefaultTimeout,
		}

	case map[string]interface{}:
		// Object format
		cmdRaw, ok := v["command"]
		if !ok {
			return nil
		}
		cmdSlice, ok := cmdRaw.([]interface{})
		if !ok {
			return nil
		}
		cmd := toStringSlice(cmdSlice)
		if len(cmd) == 0 {
			return nil
		}

		cfg := ExternalHookConfig{
			Command: cmd,
			Await:   false,
			Timeout: DefaultTimeout,
		}

		if await, ok := v["await"].(bool); ok {
			cfg.Await = await
		}
		if timeoutMs, ok := v["timeout"].(float64); ok && timeoutMs > 0 {
			cfg.Timeout = time.Duration(timeoutMs) * time.Millisecond
		}

		return &cfg
	}
	return nil
}

// Fire dispatches all hooks registered for the given event.
// Awaited hooks block until completion (or timeout). Fire-and-forget hooks run in goroutines.
func (m *ExternalHookManager) Fire(event string, payload map[string]interface{}) error {
	m.mu.RLock()
	hooks := m.registry[event]
	m.mu.RUnlock()

	if len(hooks) == 0 {
		return nil
	}

	envPayload := m.serializePayload(payload)

	var awaited []ExternalHookConfig
	for _, cfg := range hooks {
		if cfg.Await {
			awaited = append(awaited, cfg)
		} else {
			go m.runFireAndForget(cfg, event, envPayload)
		}
	}

	if len(awaited) == 0 {
		return nil
	}

	// Run all awaited hooks with a shared parent context.
	// Each hook gets its own timeout derived from its config.
	ctx := context.Background()
	var wg sync.WaitGroup
	var mu sync.Mutex
	var firstErr error

	for _, cfg := range awaited {
		wg.Add(1)
		go func(c ExternalHookConfig) {
			defer wg.Done()
			if err := m.runAwaited(ctx, c, event, envPayload); err != nil {
				mu.Lock()
				if firstErr == nil {
					firstErr = err
				}
				mu.Unlock()
			}
		}(cfg)
	}

	wg.Wait()
	return firstErr
}

// spawnHook creates and starts a subprocess for the hook command.
func (m *ExternalHookManager) spawnHook(cfg ExternalHookConfig, envPayload string) (*exec.Cmd, error) {
	if len(cfg.Command) == 0 {
		return nil, fmt.Errorf("empty command")
	}

	cmd := exec.Command(cfg.Command[0], cfg.Command[1:]...)
	cmd.Env = append(os.Environ(), "ION_EVENT="+envPayload)
	cmd.Stdout = nil
	// Stderr is not captured; it goes to /dev/null by default when Stderr is nil.

	if err := cmd.Start(); err != nil {
		return nil, fmt.Errorf("hook spawn failed: %w", err)
	}
	return cmd, nil
}

// runAwaited runs a hook and waits for completion or timeout.
func (m *ExternalHookManager) runAwaited(ctx context.Context, cfg ExternalHookConfig, event string, envPayload string) error {
	ctx, cancel := context.WithTimeout(ctx, cfg.Timeout)
	defer cancel()

	cmd, err := m.spawnHook(cfg, envPayload)
	if err != nil {
		utils.Log("hooks", fmt.Sprintf("awaited hook %s spawn error: %v", event, err))
		return err
	}

	done := make(chan error, 1)
	go func() {
		done <- cmd.Wait()
	}()

	select {
	case err := <-done:
		if err != nil {
			utils.Log("hooks", fmt.Sprintf("awaited hook %s exited with error: %v", event, err))
			return err
		}
		return nil
	case <-ctx.Done():
		if cmd.Process != nil {
			cmd.Process.Kill()
		}
		utils.Log("hooks", fmt.Sprintf("awaited hook %s timed out after %v", event, cfg.Timeout))
		return fmt.Errorf("hook %s timed out after %v", event, cfg.Timeout)
	}
}

// runFireAndForget runs a hook in the background with a kill timer.
func (m *ExternalHookManager) runFireAndForget(cfg ExternalHookConfig, event string, envPayload string) {
	cmd, err := m.spawnHook(cfg, envPayload)
	if err != nil {
		utils.Log("hooks", fmt.Sprintf("fire-and-forget hook %s spawn error: %v", event, err))
		return
	}

	// Set a kill timer so zombie processes don't linger.
	timer := time.AfterFunc(cfg.Timeout, func() {
		if cmd.Process != nil {
			cmd.Process.Kill()
			utils.Log("hooks", fmt.Sprintf("fire-and-forget hook %s killed after timeout %v", event, cfg.Timeout))
		}
	})

	err = cmd.Wait()
	timer.Stop()

	if err != nil {
		utils.Log("hooks", fmt.Sprintf("fire-and-forget hook %s exited with error: %v", event, err))
	}
}

// UpdateConfig replaces the hook registry with new configuration.
func (m *ExternalHookManager) UpdateConfig(config map[string]interface{}) {
	m.parseConfig(config)
}

// RegisteredEvents returns the list of event names that have hooks registered.
func (m *ExternalHookManager) RegisteredEvents() []string {
	m.mu.RLock()
	defer m.mu.RUnlock()

	events := make([]string, 0, len(m.registry))
	for event := range m.registry {
		events = append(events, event)
	}
	return events
}

// serializePayload marshals the payload to JSON, truncating if it exceeds MaxPayloadBytes.
func (m *ExternalHookManager) serializePayload(payload map[string]interface{}) string {
	if payload == nil {
		return "{}"
	}

	data, err := json.Marshal(payload)
	if err != nil {
		utils.Log("hooks", fmt.Sprintf("payload marshal error: %v", err))
		return "{}"
	}

	if len(data) <= MaxPayloadBytes {
		return string(data)
	}

	// Truncated: return keys only
	keys := make([]string, 0, len(payload))
	for k := range payload {
		keys = append(keys, k)
	}
	truncated := map[string]interface{}{
		"_truncated":     true,
		"_original_keys": keys,
	}
	fallback, _ := json.Marshal(truncated)
	return string(fallback)
}

// toStringSlice converts []interface{} to []string, skipping non-string elements.
func toStringSlice(raw []interface{}) []string {
	out := make([]string, 0, len(raw))
	for _, v := range raw {
		if s, ok := v.(string); ok {
			out = append(out, s)
		}
	}
	return out
}

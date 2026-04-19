package featureflags

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Source identifies where feature flags are loaded from.
type Source string

const (
	SourceStatic Source = "static"
	SourceFile   Source = "file"
	SourceHTTP   Source = "http"
)

// Config defines how to load feature flags.
type Config struct {
	Source   Source
	Path     string                 // for file source
	URL      string                 // for http source
	Interval time.Duration          // poll interval for http
	Static   map[string]interface{} // for static source
	// CachePath stores a disk cache for offline resilience (http source).
	CachePath string
}

// FeatureFlags manages runtime feature flag state.
type FeatureFlags struct {
	cfg   Config
	flags map[string]interface{}
	mu    sync.RWMutex
	done  chan struct{}
}

// New creates a FeatureFlags instance and loads initial flag values.
func New(cfg Config) *FeatureFlags {
	f := &FeatureFlags{
		cfg:   cfg,
		flags: make(map[string]interface{}),
		done:  make(chan struct{}),
	}

	// Load initial flags synchronously
	f.loadSync()

	// Start polling for HTTP source
	if cfg.Source == SourceHTTP && cfg.URL != "" {
		interval := cfg.Interval
		if interval == 0 {
			interval = 60 * time.Second
		}
		go f.pollLoop(interval)
	}

	return f
}

// IsEnabled returns true if the named flag is truthy.
func (f *FeatureFlags) IsEnabled(name string) bool {
	f.mu.RLock()
	defer f.mu.RUnlock()

	if v, ok := f.flags[name]; ok {
		return isTruthy(v)
	}
	if f.cfg.Static != nil {
		if v, ok := f.cfg.Static[name]; ok {
			return isTruthy(v)
		}
	}
	return false
}

// GetValue returns the flag value, falling back to defaultVal if not found.
func (f *FeatureFlags) GetValue(name string, defaultVal interface{}) interface{} {
	f.mu.RLock()
	defer f.mu.RUnlock()

	if v, ok := f.flags[name]; ok {
		return v
	}
	if f.cfg.Static != nil {
		if v, ok := f.cfg.Static[name]; ok {
			return v
		}
	}
	return defaultVal
}

// Refresh reloads flag values from the configured source.
func (f *FeatureFlags) Refresh() error {
	switch f.cfg.Source {
	case SourceHTTP:
		return f.fetchHTTP()
	case SourceFile:
		f.loadSync()
		return nil
	default:
		return nil
	}
}

// Close stops background polling and releases resources.
func (f *FeatureFlags) Close() {
	select {
	case <-f.done:
		// Already closed
	default:
		close(f.done)
	}
}

func (f *FeatureFlags) loadSync() {
	switch f.cfg.Source {
	case SourceStatic:
		// Static source uses cfg.Static directly via IsEnabled/GetValue fallback
		return

	case SourceFile:
		if f.cfg.Path == "" {
			return
		}
		data, err := os.ReadFile(f.cfg.Path)
		if err != nil {
			utils.Log("FeatureFlags", "failed to read flag file: "+err.Error())
			f.loadCache()
			return
		}
		var flags map[string]interface{}
		if err := json.Unmarshal(data, &flags); err != nil {
			utils.Log("FeatureFlags", "failed to parse flag file: "+err.Error())
			f.loadCache()
			return
		}
		f.mu.Lock()
		f.flags = flags
		f.mu.Unlock()

	case SourceHTTP:
		// On initial load, try cache first (HTTP fetch happens async via poll)
		f.loadCache()
	}
}

func (f *FeatureFlags) fetchHTTP() error {
	if f.cfg.URL == "" {
		return nil
	}

	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Get(f.cfg.URL)
	if err != nil {
		utils.Log("FeatureFlags", "failed to fetch flags: "+err.Error())
		return err
	}
	defer resp.Body.Close()

	body, err := io.ReadAll(resp.Body)
	if err != nil {
		utils.Log("FeatureFlags", "failed to read response: "+err.Error())
		return err
	}

	var flags map[string]interface{}
	if err := json.Unmarshal(body, &flags); err != nil {
		utils.Log("FeatureFlags", "failed to parse flags: "+err.Error())
		return err
	}

	f.mu.Lock()
	f.flags = flags
	f.mu.Unlock()

	f.saveCache()
	utils.Log("FeatureFlags", "refreshed flags from "+f.cfg.URL)
	return nil
}

func (f *FeatureFlags) pollLoop(interval time.Duration) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()

	for {
		select {
		case <-f.done:
			return
		case <-ticker.C:
			f.fetchHTTP()
		}
	}
}

func (f *FeatureFlags) loadCache() {
	if f.cfg.CachePath == "" {
		return
	}
	data, err := os.ReadFile(f.cfg.CachePath)
	if err != nil {
		return
	}
	var flags map[string]interface{}
	if err := json.Unmarshal(data, &flags); err != nil {
		return
	}
	f.mu.Lock()
	f.flags = flags
	f.mu.Unlock()
	utils.Log("FeatureFlags", "loaded flags from disk cache")
}

func (f *FeatureFlags) saveCache() {
	if f.cfg.CachePath == "" {
		return
	}
	f.mu.RLock()
	data, err := json.Marshal(f.flags)
	f.mu.RUnlock()
	if err != nil {
		return
	}
	dir := filepath.Dir(f.cfg.CachePath)
	os.MkdirAll(dir, 0o755)
	os.WriteFile(f.cfg.CachePath, data, 0o644)
}

func isTruthy(v interface{}) bool {
	switch val := v.(type) {
	case bool:
		return val
	case float64:
		return val != 0
	case string:
		return val != "" && val != "false" && val != "0"
	case nil:
		return false
	default:
		return true
	}
}

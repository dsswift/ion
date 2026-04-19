package featureflags

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestStatic_IsEnabled(t *testing.T) {
	ff := New(Config{
		Source: SourceStatic,
		Static: map[string]interface{}{
			"feature_a": true,
			"feature_b": false,
			"feature_c": "yes",
		},
	})
	defer ff.Close()

	tests := []struct {
		name string
		want bool
	}{
		{"feature_a", true},
		{"feature_b", false},
		{"feature_c", true},
		{"missing", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := ff.IsEnabled(tt.name); got != tt.want {
				t.Errorf("IsEnabled(%q) = %v, want %v", tt.name, got, tt.want)
			}
		})
	}
}

func TestStatic_GetValue(t *testing.T) {
	ff := New(Config{
		Source: SourceStatic,
		Static: map[string]interface{}{
			"limit":   float64(42),
			"message": "hello",
		},
	})
	defer ff.Close()

	if v := ff.GetValue("limit", nil); v != float64(42) {
		t.Fatalf("expected 42, got %v", v)
	}
	if v := ff.GetValue("message", nil); v != "hello" {
		t.Fatalf("expected hello, got %v", v)
	}
	if v := ff.GetValue("missing", "default"); v != "default" {
		t.Fatalf("expected default, got %v", v)
	}
}

func TestFile_IsEnabled(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "flags.json")

	flags := map[string]interface{}{
		"new_ui":    true,
		"dark_mode": false,
	}
	data, _ := json.Marshal(flags)
	os.WriteFile(path, data, 0o644)

	ff := New(Config{
		Source: SourceFile,
		Path:   path,
	})
	defer ff.Close()

	if !ff.IsEnabled("new_ui") {
		t.Fatal("expected new_ui=true")
	}
	if ff.IsEnabled("dark_mode") {
		t.Fatal("expected dark_mode=false")
	}
}

func TestFile_Refresh(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "flags.json")

	// Write initial flags
	flags := map[string]interface{}{"v1": true}
	data, _ := json.Marshal(flags)
	os.WriteFile(path, data, 0o644)

	ff := New(Config{
		Source: SourceFile,
		Path:   path,
	})
	defer ff.Close()

	if !ff.IsEnabled("v1") {
		t.Fatal("expected v1=true initially")
	}

	// Update flags
	flags = map[string]interface{}{"v1": false, "v2": true}
	data, _ = json.Marshal(flags)
	os.WriteFile(path, data, 0o644)

	if err := ff.Refresh(); err != nil {
		t.Fatalf("refresh failed: %v", err)
	}

	if ff.IsEnabled("v1") {
		t.Fatal("expected v1=false after refresh")
	}
	if !ff.IsEnabled("v2") {
		t.Fatal("expected v2=true after refresh")
	}
}

func TestFile_MissingFile_FallsBackToCache(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, "cache.json")

	// Write cache
	cached := map[string]interface{}{"cached_flag": true}
	data, _ := json.Marshal(cached)
	os.WriteFile(cachePath, data, 0o644)

	ff := New(Config{
		Source:    SourceFile,
		Path:      filepath.Join(dir, "nonexistent.json"),
		CachePath: cachePath,
	})
	defer ff.Close()

	if !ff.IsEnabled("cached_flag") {
		t.Fatal("expected cached_flag=true from cache fallback")
	}
}

func TestHTTP_FetchAndCache(t *testing.T) {
	flags := map[string]interface{}{
		"remote_feature": true,
		"count":          float64(5),
	}

	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(flags)
	}))
	defer server.Close()

	dir := t.TempDir()
	cachePath := filepath.Join(dir, "cache.json")

	ff := New(Config{
		Source:    SourceHTTP,
		URL:       server.URL,
		Interval:  1 * time.Hour, // Don't actually poll during test
		CachePath: cachePath,
	})
	defer ff.Close()

	// Fetch manually
	if err := ff.Refresh(); err != nil {
		t.Fatalf("refresh failed: %v", err)
	}

	if !ff.IsEnabled("remote_feature") {
		t.Fatal("expected remote_feature=true")
	}
	if v := ff.GetValue("count", nil); v != float64(5) {
		t.Fatalf("expected count=5, got %v", v)
	}

	// Cache should exist
	if _, err := os.Stat(cachePath); os.IsNotExist(err) {
		t.Fatal("cache file should have been written")
	}
}

func TestHTTP_CacheFallback(t *testing.T) {
	dir := t.TempDir()
	cachePath := filepath.Join(dir, "cache.json")

	// Write pre-existing cache
	cached := map[string]interface{}{"offline_flag": true}
	data, _ := json.Marshal(cached)
	os.WriteFile(cachePath, data, 0o644)

	// Create with non-reachable URL -- initial load should use cache
	ff := New(Config{
		Source:    SourceHTTP,
		URL:       "http://192.0.2.1:1/flags", // RFC 5737 TEST-NET, won't connect
		Interval:  1 * time.Hour,
		CachePath: cachePath,
	})
	defer ff.Close()

	if !ff.IsEnabled("offline_flag") {
		t.Fatal("expected offline_flag=true from cache")
	}
}

func TestClose_Idempotent(t *testing.T) {
	ff := New(Config{Source: SourceStatic})

	// Should not panic on double close
	ff.Close()
	ff.Close()
}

func TestIsTruthy(t *testing.T) {
	tests := []struct {
		name  string
		value interface{}
		want  bool
	}{
		{"true", true, true},
		{"false", false, false},
		{"1.0", float64(1), true},
		{"0.0", float64(0), false},
		{"nonempty string", "yes", true},
		{"empty string", "", false},
		{"false string", "false", false},
		{"zero string", "0", false},
		{"nil", nil, false},
		{"slice", []int{1}, true},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			if got := isTruthy(tt.value); got != tt.want {
				t.Errorf("isTruthy(%v) = %v, want %v", tt.value, got, tt.want)
			}
		})
	}
}

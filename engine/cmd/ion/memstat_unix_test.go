//go:build !windows && !darwin

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestMemTotalFromProcMeminfo(t *testing.T) {
	tests := []struct {
		name      string
		content   string
		wantBytes uint64
	}{
		{
			name: "typical linux meminfo",
			content: `MemTotal:       16384000 kB
MemFree:         8192000 kB
MemAvailable:   12288000 kB
Buffers:          512000 kB
`,
			wantBytes: 16384000 * 1024,
		},
		{
			name:      "meminfo with leading whitespace in value",
			content:   "MemTotal:       32768000 kB\nMemFree: 1000 kB\n",
			wantBytes: 32768000 * 1024,
		},
		{
			name:      "missing MemTotal",
			content:   "MemFree:         8192000 kB\n",
			wantBytes: 0,
		},
		{
			name:      "empty file",
			content:   "",
			wantBytes: 0,
		},
		{
			name:      "malformed MemTotal line",
			content:   "MemTotal:\n",
			wantBytes: 0,
		},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			dir := t.TempDir()
			path := filepath.Join(dir, "meminfo")
			if err := os.WriteFile(path, []byte(tc.content), 0600); err != nil {
				t.Fatalf("write fixture: %v", err)
			}
			got := memTotalFromProcMeminfo(path)
			if got != tc.wantBytes {
				t.Errorf("memTotalFromProcMeminfo() = %d, want %d", got, tc.wantBytes)
			}
		})
	}

	t.Run("missing file", func(t *testing.T) {
		got := memTotalFromProcMeminfo("/nonexistent/path/meminfo")
		if got != 0 {
			t.Errorf("expected 0 for missing file, got %d", got)
		}
	})
}

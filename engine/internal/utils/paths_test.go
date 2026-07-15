package utils

import (
	"os"
	"testing"
)

func TestExpandHomePath(t *testing.T) {
	home, err := os.UserHomeDir()
	if err != nil {
		t.Skip("cannot determine home dir")
	}

	tests := []struct {
		name  string
		input string
		want  string
	}{
		{"tilde slash prefix", "~/foo/bar", home + "/foo/bar"},
		{"bare tilde", "~", home},
		{"absolute path unchanged", "/absolute/path", "/absolute/path"},
		{"relative path unchanged", "relative/path", "relative/path"},
		{"empty unchanged", "", ""},
		{"tilde in middle unchanged", "/some/~path", "/some/~path"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ExpandHomePath(tt.input)
			if got != tt.want {
				t.Errorf("ExpandHomePath(%q) = %q, want %q", tt.input, got, tt.want)
			}
		})
	}
}

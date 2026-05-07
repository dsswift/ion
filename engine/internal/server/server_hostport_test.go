package server

import "testing"

func TestLooksLikeHostPort(t *testing.T) {
	tests := []struct {
		path string
		want bool
	}{
		// TCP host:port patterns — should return true
		{"127.0.0.1:21017", true},
		{"0.0.0.0:8080", true},
		{"192.168.1.100:9000", true},
		{"localhost:21017", true},
		{"myhost:443", true},

		// Unix socket paths — should return false
		{"/Users/josh/.ion/engine.sock", false},
		{"/tmp/ion.sock", false},
		{"./engine.sock", false},
		{"../ion.sock", false},

		// Edge cases
		{"", false},
		{"/colon:path", false},   // absolute path with colon
		{"./colon:path", false},  // relative path with colon

		// Windows named pipe path (no colon, starts with \\)
		// Not applicable here since we only test the function logic
	}

	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			got := looksLikeHostPort(tt.path)
			if got != tt.want {
				t.Errorf("looksLikeHostPort(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

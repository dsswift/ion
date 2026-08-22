package mcp

import "testing"

func TestAccumulateScopes(t *testing.T) {
	tests := []struct {
		name      string
		existing  string
		challenge string
		want      string
	}{
		{"empty both", "", "", ""},
		{"existing only", "read write", "", "read write"},
		{"challenge only", "", "admin write", "admin write"},
		{"union dedup", "read write", "write admin", "admin read write"},
		{"identical", "read", "read", "read"},
		{"sorted", "z a m", "b", "a b m z"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := AccumulateScopes(tt.existing, tt.challenge)
			if got != tt.want {
				t.Errorf("AccumulateScopes(%q, %q) = %q, want %q", tt.existing, tt.challenge, got, tt.want)
			}
		})
	}
}

func TestParseBearerScope(t *testing.T) {
	tests := []struct {
		name   string
		header string
		want   string
	}{
		{"no scope", `Bearer realm="example"`, ""},
		{"with scope", `Bearer realm="example", scope="read write"`, "read write"},
		{"scope only", `Bearer scope="admin"`, "admin"},
		{"case-insensitive key", `Bearer SCOPE="Read"`, "Read"},
		{"unquoted scope", `Bearer scope=read`, "read"},
		{"empty scope", `Bearer scope=""`, ""},
		{"scope at end", `Bearer realm="x", scope="a b c"`, "a b c"},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			got := ParseBearerScope(tt.header)
			if got != tt.want {
				t.Errorf("ParseBearerScope(%q) = %q, want %q", tt.header, got, tt.want)
			}
		})
	}
}

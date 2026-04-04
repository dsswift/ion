package main

import (
	"net/http"
	"testing"
)

func TestAuthMiddleware(t *testing.T) {
	auth := NewAuthMiddleware("secret-key-123")

	tests := []struct {
		name   string
		header string
		want   bool
	}{
		{"valid key", "Bearer secret-key-123", true},
		{"wrong key", "Bearer wrong-key", false},
		{"empty header", "", false},
		{"no bearer prefix", "secret-key-123", false},
		{"basic auth", "Basic secret-key-123", false},
		{"bearer lowercase", "bearer secret-key-123", true},
		{"extra spaces in token", "Bearer  secret-key-123", false},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}
			got := auth.Validate(req)
			if got != tt.want {
				t.Errorf("Validate() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAuthTimingSafety(t *testing.T) {
	// Verify that similar-length keys don't cause different behavior.
	auth := NewAuthMiddleware("abcdefghijklmnop")

	req1, _ := http.NewRequest("GET", "/", nil)
	req1.Header.Set("Authorization", "Bearer abcdefghijklmnoq") // off by one char
	if auth.Validate(req1) {
		t.Error("should reject near-miss key")
	}

	req2, _ := http.NewRequest("GET", "/", nil)
	req2.Header.Set("Authorization", "Bearer abcdefghijklmnop")
	if !auth.Validate(req2) {
		t.Error("should accept exact key")
	}
}

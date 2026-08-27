package main

import (
	"encoding/json"
	"net/http"
	"testing"
)

func TestAuthMiddleware(t *testing.T) {
	auth := NewAuthMiddleware("secret-key-123", nil)

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
			_, got := auth.Validate(req)
			if got != tt.want {
				t.Errorf("Validate() = %v, want %v", got, tt.want)
			}
		})
	}
}

func TestAuthMiddlewareValidateDetailed(t *testing.T) {
	auth := NewAuthMiddleware("secret-key-123", nil)

	tests := []struct {
		name       string
		header     string
		wantReason AuthFailureReason
	}{
		{"valid key", "Bearer secret-key-123", ""},
		{"missing header", "", authFailureMissingAuthorization},
		{"missing bearer value", "Bearer", authFailureMalformedAuthorization},
		{"empty bearer value", "Bearer ", authFailureMalformedAuthorization},
		{"invalid scheme", "Basic secret-key-123", authFailureInvalidScheme},
		{"wrong key", "Bearer wrong-key", authFailurePSKMismatch},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			req, _ := http.NewRequest("GET", "/", nil)
			if tt.header != "" {
				req.Header.Set("Authorization", tt.header)
			}

			_, reason := auth.ValidateDetailed(req)
			if reason != tt.wantReason {
				t.Errorf("ValidateDetailed() reason = %q, want %q", reason, tt.wantReason)
			}
		})
	}
}

func TestAuthMiddlewareValidateDetailedJWTFailureIsSafe(t *testing.T) {
	auth := NewAuthMiddleware("", &OIDCConfig{})
	req, _ := http.NewRequest("GET", "/", nil)
	req.Header.Set("Authorization", "Bearer invalid.jwt.token")

	_, reason := auth.ValidateDetailed(req)
	if reason != authFailureJWTValidation {
		t.Errorf("ValidateDetailed() reason = %q, want %q", reason, authFailureJWTValidation)
	}
	if reason == AuthFailureReason("invalid.jwt.token") {
		t.Error("ValidateDetailed() returned the bearer token as its failure reason")
	}
}

func TestLogAuthFailureLogsSafeReason(t *testing.T) {
	testLogger, buf := captureLogger()
	originalLogger := logger
	logger = testLogger
	t.Cleanup(func() { logger = originalLogger })

	req, _ := http.NewRequest("GET", "/", nil)
	logAuthFailure(req, authFailureJWTValidation)

	var entry struct {
		Tag    string `json:"tag"`
		Reason string `json:"reason"`
	}
	if err := json.Unmarshal(buf.Bytes(), &entry); err != nil {
		t.Fatalf("decode auth failure log: %v", err)
	}
	if entry.Tag != "relay.auth.failure" {
		t.Errorf("log tag = %q, want relay.auth.failure", entry.Tag)
	}
	if entry.Reason != string(authFailureJWTValidation) {
		t.Errorf("log reason = %q, want %q", entry.Reason, authFailureJWTValidation)
	}
}

func TestAuthTimingSafety(t *testing.T) {
	// Verify that similar-length keys don't cause different behavior.
	auth := NewAuthMiddleware("abcdefghijklmnop", nil)

	req1, _ := http.NewRequest("GET", "/", nil)
	req1.Header.Set("Authorization", "Bearer abcdefghijklmnoq") // off by one char
	if _, ok := auth.Validate(req1); ok {
		t.Error("should reject near-miss key")
	}

	req2, _ := http.NewRequest("GET", "/", nil)
	req2.Header.Set("Authorization", "Bearer abcdefghijklmnop")
	if _, ok := auth.Validate(req2); !ok {
		t.Error("should accept exact key")
	}
}

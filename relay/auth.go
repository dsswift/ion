package main

import (
	"crypto/subtle"
	"net/http"
	"strings"
)

// AuthMiddleware validates the API key on WebSocket upgrade requests.
type AuthMiddleware struct {
	apiKey []byte
}

func NewAuthMiddleware(apiKey string) *AuthMiddleware {
	return &AuthMiddleware{apiKey: []byte(apiKey)}
}

// Validate checks the Authorization: Bearer header against the configured API key.
// Uses constant-time comparison to prevent timing attacks.
func (a *AuthMiddleware) Validate(r *http.Request) bool {
	header := r.Header.Get("Authorization")
	if header == "" {
		return false
	}

	parts := strings.SplitN(header, " ", 2)
	if len(parts) != 2 || !strings.EqualFold(parts[0], "Bearer") {
		return false
	}

	token := []byte(parts[1])
	return subtle.ConstantTimeCompare(token, a.apiKey) == 1
}

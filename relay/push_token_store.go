package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
)

// tokenStore persists APNs device tokens per channel to a directory so tokens
// survive channel deletion (which occurs on every desktop restart while the
// phone is away) and relay restarts.
//
// The relay exists precisely to handle the phone-is-away state, so losing the
// APNs token when both peers disconnect would silently disable the primary use
// case of the APNs push feature.
type tokenStore struct {
	mu  sync.Mutex
	dir string // directory that holds per-channel token files; empty = disabled
}

// newTokenStore creates a store backed by dir. If dir is empty the store
// operates in memory-only mode (no files read or written).
func newTokenStore(dir string) *tokenStore {
	return &tokenStore{dir: dir}
}

// Set persists token for channelID. A blank token clears the persisted entry.
func (s *tokenStore) Set(channelID, token string) {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dir == "" {
		return
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		logger.Warn("tokenStore: mkdir failed", "tag", "relay.push_token_store", "err", err)
		return
	}
	path := s.tokenPath(channelID)
	if token == "" {
		_ = os.Remove(path)
		return
	}
	data, err := json.Marshal(map[string]string{"token": token})
	if err != nil {
		logger.Warn("tokenStore: marshal failed", "tag", "relay.push_token_store", "err", err)
		return
	}
	// Write to a temp file then rename for atomic replacement.
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		logger.Warn("tokenStore: write failed", "tag", "relay.push_token_store", "err", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		logger.Warn("tokenStore: rename failed", "tag", "relay.push_token_store", "err", err)
		_ = os.Remove(tmp)
	}
}

// Get returns the persisted token for channelID, or "" when none exists.
func (s *tokenStore) Get(channelID string) string {
	s.mu.Lock()
	defer s.mu.Unlock()

	if s.dir == "" {
		return ""
	}
	data, err := os.ReadFile(s.tokenPath(channelID))
	if err != nil {
		return ""
	}
	var v map[string]string
	if err := json.Unmarshal(data, &v); err != nil {
		return ""
	}
	return v["token"]
}

func (s *tokenStore) tokenPath(channelID string) string {
	return filepath.Join(s.dir, "apns-"+channelID+".json")
}

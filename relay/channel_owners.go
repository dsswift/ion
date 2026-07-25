package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"sync"
	"time"
)

// channelOwnerEntry records which OIDC subject owns a relay channel.
type channelOwnerEntry struct {
	Subject string    `json:"subject"`
	BoundAt time.Time `json:"bound_at"`
}

// maxChannelIDLen bounds a channel ID so a pathological value cannot produce an
// unbounded filename.
const maxChannelIDLen = 128

// validChannelID reports whether a channel ID is safe to use in a filesystem
// path. The channel ID composes an owner filename (owner-<channelID>.json), so
// it must not contain path separators, traversal sequences, or control/space
// characters. Go's ServeMux already blocks "/" and ".." in a single path
// segment, but this guard is defense-in-depth: a future router change or a
// non-mux caller must not be able to write outside RELAY_STATE_DIR. Allow only
// a conservative token charset (alphanumerics, dash, underscore, dot) with no
// leading dot (so "." / ".." are rejected).
func validChannelID(id string) bool {
	if id == "" || len(id) > maxChannelIDLen || id[0] == '.' {
		return false
	}
	for _, r := range id {
		switch {
		case r >= 'a' && r <= 'z', r >= 'A' && r <= 'Z', r >= '0' && r <= '9':
		case r == '-' || r == '_' || r == '.':
		default:
			return false
		}
	}
	return true
}

// channelOwnerStore persists channel→subject ownership to RELAY_STATE_DIR so
// bindings survive relay restarts. PSK connections bypass ownership entirely.
//
// Thread-safety: all public methods are protected by mu.
type channelOwnerStore struct {
	mu      sync.Mutex
	dir     string                       // RELAY_STATE_DIR; empty = memory-only
	owners  map[string]channelOwnerEntry // channelID → entry
}

// newChannelOwnerStore creates a store. dir may be empty (memory-only).
// Existing entries in dir are loaded at construction time.
func newChannelOwnerStore(dir string) *channelOwnerStore {
	s := &channelOwnerStore{
		dir:    dir,
		owners: make(map[string]channelOwnerEntry),
	}
	s.loadFromDisk()
	return s
}

// Bind binds a channel to the given subject. Returns true if the bind was
// accepted (channel was unowned or already owned by the same subject), false if
// the channel is owned by a different subject (caller must reject).
//
// On the first call for an unowned channel, the entry is persisted to disk.
func (s *channelOwnerStore) Bind(channelID, subject string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()

	existing, ok := s.owners[channelID]
	if ok {
		return existing.Subject == subject
	}

	entry := channelOwnerEntry{Subject: subject, BoundAt: time.Now()}
	s.owners[channelID] = entry
	s.persist(channelID, entry)

	logger.Info("oidc: channel bound to subject",
		"tag", "relay.channel.bind",
		"channel_id", channelID,
		"subject", subject)
	return true
}

// Owner returns the owning subject for a channel and whether one is set.
func (s *channelOwnerStore) Owner(channelID string) (string, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	e, ok := s.owners[channelID]
	if !ok {
		return "", false
	}
	return e.Subject, true
}

// loadFromDisk reads all channel-owner files from dir.
func (s *channelOwnerStore) loadFromDisk() {
	if s.dir == "" {
		return
	}
	pattern := filepath.Join(s.dir, "owner-*.json")
	matches, err := filepath.Glob(pattern)
	if err != nil {
		// A glob failure drops every persisted binding for this run, which
		// silently makes every channel rebindable by a different subject.
		// Never silent.
		logger.Warn("channelOwnerStore: glob failed; no bindings loaded",
			"tag", "relay.channel_owner_store", "pattern", pattern, "err", err)
		return
	}
	for _, path := range matches {
		data, err := os.ReadFile(path)
		if err != nil {
			// A dropped binding lets a different subject rebind this channel;
			// surface it rather than continuing blind.
			logger.Warn("channelOwnerStore: read failed; skipping binding",
				"tag", "relay.channel_owner_store", "path", path, "err", err)
			continue
		}
		var entry channelOwnerEntry
		if err := json.Unmarshal(data, &entry); err != nil {
			logger.Warn("channelOwnerStore: unmarshal failed; skipping binding",
				"tag", "relay.channel_owner_store", "path", path, "err", err)
			continue
		}
		// Derive channelID from filename: "owner-<channelID>.json".
		base := filepath.Base(path)
		channelID := base[len("owner-") : len(base)-len(".json")]
		if channelID == "" || entry.Subject == "" {
			logger.Warn("channelOwnerStore: malformed owner file; skipping binding",
				"tag", "relay.channel_owner_store", "path", path)
			continue
		}
		s.owners[channelID] = entry
	}
}

// persist writes the entry to disk atomically.
func (s *channelOwnerStore) persist(channelID string, entry channelOwnerEntry) {
	if s.dir == "" {
		return
	}
	if err := os.MkdirAll(s.dir, 0o700); err != nil {
		logger.Warn("channelOwnerStore: mkdir failed",
			"tag", "relay.channel_owner_store", "err", err)
		return
	}
	data, err := json.Marshal(entry)
	if err != nil {
		logger.Warn("channelOwnerStore: marshal failed",
			"tag", "relay.channel_owner_store", "err", err)
		return
	}
	path := s.ownerPath(channelID)
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, data, 0o600); err != nil {
		logger.Warn("channelOwnerStore: write failed",
			"tag", "relay.channel_owner_store", "err", err)
		return
	}
	if err := os.Rename(tmp, path); err != nil {
		logger.Warn("channelOwnerStore: rename failed",
			"tag", "relay.channel_owner_store", "err", err)
		os.Remove(tmp) //nolint:errcheck // temp cleanup after failed rename
	}
}

func (s *channelOwnerStore) ownerPath(channelID string) string {
	return filepath.Join(s.dir, "owner-"+channelID+".json")
}

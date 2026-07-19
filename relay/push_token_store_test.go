package main

import (
	"os"
	"path/filepath"
	"testing"
)

// TestTokenStore_SetAndGet verifies that a token written for a channel ID can
// be read back immediately.
func TestTokenStore_SetAndGet(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := newTokenStore(dir)

	s.Set("ch-abc", "device-token-123")
	got := s.Get("ch-abc")
	if got != "device-token-123" {
		t.Errorf("Get = %q, want %q", got, "device-token-123")
	}
}

// TestTokenStore_GetMissing verifies that Get returns "" for an unknown channel.
func TestTokenStore_GetMissing(t *testing.T) {
	t.Parallel()
	s := newTokenStore(t.TempDir())
	if got := s.Get("no-such-channel"); got != "" {
		t.Errorf("expected empty string for missing channel, got %q", got)
	}
}

// TestTokenStore_SetEmpty clears the persisted file.
func TestTokenStore_SetEmpty(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()
	s := newTokenStore(dir)

	s.Set("ch-clear", "old-token")
	s.Set("ch-clear", "") // clear
	got := s.Get("ch-clear")
	if got != "" {
		t.Errorf("expected empty after clear, got %q", got)
	}
	if _, err := os.Stat(filepath.Join(dir, "apns-ch-clear.json")); !os.IsNotExist(err) {
		t.Error("expected file to be removed after Set('')")
	}
}

// TestTokenStore_SurvivesRecreation verifies that a new tokenStore instance
// reading the same directory sees the previously persisted token (simulates
// relay restart).
func TestTokenStore_SurvivesRecreation(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	s1 := newTokenStore(dir)
	s1.Set("ch-persist", "token-survives-restart")

	s2 := newTokenStore(dir)
	got := s2.Get("ch-persist")
	if got != "token-survives-restart" {
		t.Errorf("token not recovered after relay restart simulation: got %q, want %q", got, "token-survives-restart")
	}
}

// TestTokenStore_DisabledWhenNoDir verifies that a store with an empty dir
// string operates without error (memory-only mode, returns "" on Get).
func TestTokenStore_DisabledWhenNoDir(t *testing.T) {
	t.Parallel()
	s := newTokenStore("")
	s.Set("ch-mem", "any-token") // must not panic
	if got := s.Get("ch-mem"); got != "" {
		t.Errorf("disabled store should always return empty, got %q", got)
	}
}

// TestHub_TokenRestoredOnChannelRecreation is an integration-level test for
// the fix in #283: when a Channel is deleted by removeIfEmpty (desktop
// restarted while phone is away) and then recreated by getOrCreateChannel,
// the persisted APNs token must be present on the new Channel immediately —
// without waiting for the phone to reconnect and re-supply the token.
func TestHub_TokenRestoredOnChannelRecreation(t *testing.T) {
	t.Parallel()
	dir := t.TempDir()

	hub := NewHub()
	hub.tokens = newTokenStore(dir)

	// Simulate: phone connects and sets its token via the store (as the
	// handleWebSocket path does when it captures ?apns_token=).
	hub.tokens.Set("chan-1", "phone-device-token")

	// Simulate: channel deleted (desktop disconnected while phone was away).
	hub.mu.Lock()
	hub.channels["chan-1"] = &Channel{apnsToken: "phone-device-token"}
	hub.mu.Unlock()
	hub.removeIfEmpty("chan-1") // both peers nil → deleted

	if hub.ChannelCount() != 0 {
		t.Fatal("expected channel to be deleted after removeIfEmpty")
	}

	// Simulate: desktop reconnects and getOrCreateChannel is called.
	ch := hub.getOrCreateChannel("chan-1")

	ch.mu.Lock()
	token := ch.apnsToken
	ch.mu.Unlock()

	if token != "phone-device-token" {
		t.Errorf("APNs token not restored on channel recreation: got %q, want %q", token, "phone-device-token")
	}
}

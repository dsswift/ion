package main

import (
	"crypto/ecdsa"
	"crypto/elliptic"
	"crypto/rand"
	"crypto/x509"
	"encoding/pem"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// testP8 returns a PEM-encoded PKCS#8 P-256 key, the shape of an APNs .p8 file.
func testP8(t *testing.T) string {
	t.Helper()
	priv, err := ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
	if err != nil {
		t.Fatalf("generate key: %v", err)
	}
	der, err := x509.MarshalPKCS8PrivateKey(priv)
	if err != nil {
		t.Fatalf("marshal key: %v", err)
	}
	return string(pem.EncodeToMemory(&pem.Block{Type: "PRIVATE KEY", Bytes: der}))
}

// TestAPNsKeyFromEnvText pins that APNS_KEY carries the key text itself, so a
// secret store that injects values as environment variables needs no file.
func TestAPNsKeyFromEnvText(t *testing.T) {
	p8 := testP8(t)
	key, source, err := loadAPNsKey("", p8)
	if err != nil {
		t.Fatalf("loadAPNsKey: %v", err)
	}
	if source != "APNS_KEY" {
		t.Fatalf("source = %q, want APNS_KEY", source)
	}
	pusher, err := NewAPNsPusher(key, "KID", "TEAM", "com.example.ion")
	if err != nil {
		t.Fatalf("NewAPNsPusher from APNS_KEY text: %v", err)
	}
	if pusher.key == nil {
		t.Fatal("pusher has no signing key")
	}
}

// TestAPNsKeyFromPath keeps the mounted-file form working.
func TestAPNsKeyFromPath(t *testing.T) {
	path := filepath.Join(t.TempDir(), "AuthKey.p8")
	if err := os.WriteFile(path, []byte(testP8(t)), 0o600); err != nil {
		t.Fatalf("write key: %v", err)
	}
	key, source, err := loadAPNsKey(path, "")
	if err != nil {
		t.Fatalf("loadAPNsKey: %v", err)
	}
	if source != "APNS_KEY_PATH" {
		t.Fatalf("source = %q, want APNS_KEY_PATH", source)
	}
	if _, err := NewAPNsPusher(key, "KID", "TEAM", "com.example.ion"); err != nil {
		t.Fatalf("NewAPNsPusher from APNS_KEY_PATH: %v", err)
	}
}

// TestAPNsKeyBothSetRefused pins that the relay refuses to guess between two keys.
func TestAPNsKeyBothSetRefused(t *testing.T) {
	_, _, err := loadAPNsKey("/some/key.p8", testP8(t))
	if err == nil || !strings.Contains(err.Error(), "set exactly one") {
		t.Fatalf("expected a refusal naming both settings, got %v", err)
	}
}

// TestAPNsKeyNeitherSet reports no key and no error: push is simply off.
func TestAPNsKeyNeitherSet(t *testing.T) {
	key, source, err := loadAPNsKey("", "")
	if err != nil || key != nil || source != "" {
		t.Fatalf("got key=%v source=%q err=%v, want nothing", key != nil, source, err)
	}
}

// TestStartAPNsDisabledWithoutKey pins that a relay missing any push setting
// starts without a pusher instead of failing, and with every setting present
// starts one from the env text alone.
func TestStartAPNsDisabledWithoutKey(t *testing.T) {
	if p := startAPNs(Config{APNsKeyID: "KID", APNsTeamID: "TEAM", APNsTopic: "com.example.ion"}); p != nil {
		t.Fatal("expected no pusher without a key")
	}
	if p := startAPNs(Config{APNsKeyPEM: testP8(t), APNsKeyID: "KID", APNsTeamID: "TEAM", APNsTopic: "com.example.ion"}); p == nil {
		t.Fatal("expected a pusher from APNS_KEY with every setting present")
	}
}

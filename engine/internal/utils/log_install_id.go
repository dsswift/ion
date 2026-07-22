package utils

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"
	"sync"
)

// log_install_id.go — the shared per-install anonymous device identifier.
//
// install_id is a stable UUID minted once at ~/.ion/install_id and never
// changed (feature 0008). It is a per-INSTALL identity — distinct from
// machine_id (the hardware UUID carried in egress ambient fields). Both ship on
// egress records: install_id joins egress to the telemetry stream (which stamps
// the same value), machine_id stays hardware-stable across reinstalls. This
// accessor is the single source of truth so telemetry and egress mint/read the
// same value (telemetry's resolvedInstallID delegates here — telemetry imports
// utils, so there is no cycle).

var (
	installIDOnce sync.Once
	installID     string
)

// InstallID returns the per-install anonymous UUID, minting it on the first
// call and persisting it to ~/.ion/install_id. Thread-safe; stable for the
// process lifetime.
func InstallID() string {
	installIDOnce.Do(func() {
		installID = loadOrMintInstallID()
	})
	return installID
}

// loadOrMintInstallID reads ~/.ion/install_id, minting a fresh UUID v4 if
// absent (or the file is empty/unreadable).
func loadOrMintInstallID() string {
	home, err := os.UserHomeDir()
	if err != nil {
		return ""
	}
	idPath := filepath.Join(home, ".ion", "install_id")
	if data, err := os.ReadFile(idPath); err == nil {
		id := string(data)
		// Trim trailing whitespace/newlines from a human-edited file.
		for len(id) > 0 && (id[len(id)-1] == '\n' || id[len(id)-1] == '\r' || id[len(id)-1] == ' ') {
			id = id[:len(id)-1]
		}
		if id != "" {
			return id
		}
	}
	id := mintUUIDv4()
	if err := os.MkdirAll(filepath.Dir(idPath), 0o700); err != nil {
		LogWithFields(LevelInfo, "install_id", "mkdir for install_id failed; id not persisted", map[string]any{"error": err.Error()})
	}
	if err := os.WriteFile(idPath, []byte(id+"\n"), 0o600); err != nil {
		LogWithFields(LevelInfo, "install_id", "write install_id failed; id not persisted", map[string]any{"error": err.Error()})
	}
	LogWithFields(LevelInfo, "install_id", "install id minted", map[string]any{"install_id": id})
	return id
}

// mintUUIDv4 generates a new random UUID v4 string.
func mintUUIDv4() string {
	b := make([]byte, 16)
	if _, err := rand.Read(b); err != nil {
		// Fallback: 32 hex chars (non-UUID but unique enough as a last resort).
		fb := make([]byte, 16)
		_, _ = rand.Read(fb) //nolint:errcheck // best-effort fallback; a partial read still yields a usable id
		return hex.EncodeToString(fb)
	}
	b[6] = (b[6] & 0x0f) | 0x40
	b[8] = (b[8] & 0x3f) | 0x80
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:16])
}

// GenEventID returns a per-record unique identifier: 16 hex chars (8 random
// bytes). Matches the telemetry event_id generator so egress records and
// telemetry events use the same shape for downstream dedup.
func GenEventID() string {
	b := make([]byte, 8)
	_, _ = rand.Read(b) //nolint:errcheck // best-effort; a partial read still yields a usable id
	return hex.EncodeToString(b)
}

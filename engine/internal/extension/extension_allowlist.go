package extension

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrExtensionBlocked is returned by Host.Load when the enterprise extension
// allowlist (feature 0011 / D-020, issue #308) rejects an extension — either
// because its identifier is not listed, or because its entry-point file's
// SHA-256 does not match a pinned hash. Callers (the session layer) surface it
// to clients with the distinct ErrorCode "extension_blocked".
var ErrExtensionBlocked = errors.New("extension blocked by enterprise allowlist")

// checkExtensionAllowlist enforces the enterprise extension allowlist against a
// resolved extension. identifier is the final extension identity (manifest name
// else directory basename); entryPath is the resolved entry-point file used for
// integrity hashing.
//
// Enforcement rules (per issue #308):
//   - empty allowlist  -> pass (unchanged behavior; no restriction).
//   - identifier not listed -> block (reason "name").
//   - matching entry with a SHA256 -> hash the entry-point file and compare
//     (hex, case-insensitive); mismatch -> block (reason "hash").
//   - matching entry without a SHA256 -> pass (allow by identifier only).
//
// Both the block and success branches log so the decision is observable.
func checkExtensionAllowlist(identifier, entryPath string, allowlist []types.ExtensionAllowlistEntry) error {
	if len(allowlist) == 0 {
		utils.LogWithFields(utils.LevelDebug, "extension", "extension allowlist empty; load permitted", map[string]any{"extension": identifier})
		return nil
	}

	var entry *types.ExtensionAllowlistEntry
	for i := range allowlist {
		if allowlist[i].ID == identifier {
			entry = &allowlist[i]
			break
		}
	}
	if entry == nil {
		utils.LogWithFields(utils.LevelInfo, "extension", "extension blocked by enterprise allowlist", map[string]any{"extension": identifier, "reason": "name"})
		return fmt.Errorf("%w: %q is not in the enterprise extension allowlist (reason: name)", ErrExtensionBlocked, identifier)
	}

	if entry.SHA256 != "" {
		actual, err := hashFile(entryPath)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "extension", "extension allowlist hash read failed; blocking", map[string]any{"extension": identifier, "entry": entryPath, "error": err.Error()})
			return fmt.Errorf("%w: %q entry-point hash could not be computed (reason: hash): %v", ErrExtensionBlocked, identifier, err)
		}
		if !strings.EqualFold(actual, entry.SHA256) {
			utils.LogWithFields(utils.LevelInfo, "extension", "extension blocked by enterprise allowlist", map[string]any{"extension": identifier, "reason": "hash", "expected": entry.SHA256, "actual": actual})
			return fmt.Errorf("%w: %q entry-point SHA-256 %s does not match pinned %s (reason: hash)", ErrExtensionBlocked, identifier, actual, entry.SHA256)
		}
		utils.LogWithFields(utils.LevelDebug, "extension", "extension allowlist hash verified; load permitted", map[string]any{"extension": identifier})
		return nil
	}

	utils.LogWithFields(utils.LevelDebug, "extension", "extension allowlisted by identifier; load permitted", map[string]any{"extension": identifier})
	return nil
}

// hashFile returns the hex-encoded SHA-256 of the file at path.
func hashFile(path string) (string, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

package server

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/utils"
)

// loadDesktopProtectedIDs reads the desktop's persisted session-chains and
// session-labels files for both backends (api + cli) and returns the union of
// every conversation ID that appears as a chain root, a chain continuation,
// or a labeled session.
//
// This is the engine's load-bearing safety guard for the cleanup job (Layer 1
// of docs/plans/grassy-chirping-crest.md): even when the desktop's excludeIDs
// list arrives empty — because it raced startup, because IPC dropped, or
// because the lazy `require('./settings-store')` returned undefined — the
// engine can still reconstruct the set of "any conversation a tab has ever
// resumed or labeled" by reading these files directly.
//
// homeDir is the path to ~/.ion (the same directory that contains
// session-chains-{api,cli}.json and session-labels-{api,cli}.json). When
// empty, it falls back to os.UserHomeDir() + "/.ion".
//
// Missing files contribute zero IDs (never an error). Malformed JSON is
// logged at Error level and the file is skipped, but the cleanup must
// still proceed using whichever sources are readable — partial data is
// strictly safer than aborting the cleanup with zero guards.
func loadDesktopProtectedIDs(homeDir string) []string {
	if homeDir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			utils.Error("Cleanup", fmt.Sprintf("loadDesktopProtectedIDs: cannot resolve home dir: %v", err))
			return nil
		}
		homeDir = filepath.Join(home, ".ion")
	}

	ids := make(map[string]bool)

	// session-chains-{backend}.json shape: {"chains": {rootId: [contIds...]}, "reverse": {contId: rootId}}
	// Every key and every value in both maps is a conversation ID that some tab
	// references — they all need protection.
	for _, backend := range []string{"api", "cli"} {
		path := filepath.Join(homeDir, "session-chains-"+backend+".json")
		fromChains := loadChainIDs(path)
		for _, id := range fromChains {
			if id != "" {
				ids[id] = true
			}
		}
		utils.Debug("Cleanup", fmt.Sprintf("loadDesktopProtectedIDs: chains backend=%s path=%s ids=%d", backend, path, len(fromChains)))
	}

	// session-labels-{backend}.json shape: {conversationId: "user-given title"}
	// Every key is a labeled conversation that must be preserved.
	for _, backend := range []string{"api", "cli"} {
		path := filepath.Join(homeDir, "session-labels-"+backend+".json")
		fromLabels := loadLabelIDs(path)
		for _, id := range fromLabels {
			if id != "" {
				ids[id] = true
			}
		}
		utils.Debug("Cleanup", fmt.Sprintf("loadDesktopProtectedIDs: labels backend=%s path=%s ids=%d", backend, path, len(fromLabels)))
	}

	out := make([]string, 0, len(ids))
	for id := range ids {
		out = append(out, id)
	}
	utils.Log("Cleanup", fmt.Sprintf("loadDesktopProtectedIDs: home=%s total=%d", homeDir, len(out)))
	return out
}

// loadChainIDs reads a session-chains-{backend}.json file and returns every
// conversation ID it references (chain roots + chain continuations + reverse
// map keys, all unioned). Returns nil if the file is missing or unreadable.
// Malformed JSON is logged and treated as nil — never propagates an error
// upward because the cleanup must always proceed using the readable subset.
func loadChainIDs(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			utils.Error("Cleanup", fmt.Sprintf("loadChainIDs: read failed path=%s err=%v", path, err))
		}
		return nil
	}
	var parsed struct {
		Chains  map[string][]string `json:"chains"`
		Reverse map[string]string   `json:"reverse"`
	}
	if err := json.Unmarshal(data, &parsed); err != nil {
		utils.Error("Cleanup", fmt.Sprintf("loadChainIDs: malformed JSON path=%s err=%v", path, err))
		return nil
	}
	seen := make(map[string]bool)
	for rootID, continuations := range parsed.Chains {
		seen[rootID] = true
		for _, contID := range continuations {
			seen[contID] = true
		}
	}
	for contID, rootID := range parsed.Reverse {
		seen[contID] = true
		seen[rootID] = true
	}
	out := make([]string, 0, len(seen))
	for id := range seen {
		out = append(out, id)
	}
	return out
}

// loadLabelIDs reads a session-labels-{backend}.json file and returns every
// conversation ID that has a user-set label. The file is a flat object
// mapping conversationId -> label text; the values are not needed here,
// only the keys (which are conversation IDs to protect from deletion).
//
// Returns nil if missing or unreadable. Malformed JSON is logged and
// treated as nil — see loadChainIDs for rationale.
func loadLabelIDs(path string) []string {
	data, err := os.ReadFile(path)
	if err != nil {
		if !os.IsNotExist(err) {
			utils.Error("Cleanup", fmt.Sprintf("loadLabelIDs: read failed path=%s err=%v", path, err))
		}
		return nil
	}
	var parsed map[string]string
	if err := json.Unmarshal(data, &parsed); err != nil {
		utils.Error("Cleanup", fmt.Sprintf("loadLabelIDs: malformed JSON path=%s err=%v", path, err))
		return nil
	}
	out := make([]string, 0, len(parsed))
	for id := range parsed {
		out = append(out, id)
	}
	return out
}

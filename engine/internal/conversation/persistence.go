package conversation

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/durablefile"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// ErrNotFound is returned by Load when no conversation file exists for the
// given ID. Callers can use errors.Is(err, ErrNotFound) to distinguish
// "conversation does not exist" from "conversation exists but is corrupt or
// unreadable".
var ErrNotFound = errors.New("conversation not found")

// maxScanTokenSize is the maximum line size for JSONL scanners in the
// conversation package. Set to 32 MB to accommodate large tool results,
// assistant responses with embedded content, and base64-encoded images
// (the image validator allows up to 20 MB images, which inflate to ~27 MB
// in base64). The server and stream parsers use 8 MB; conversation lines
// can be larger because they accumulate entire turn payloads.
const maxScanTokenSize = 32 * 1024 * 1024

// MigrateConversation upgrades a raw JSON map to the current schema version.
func MigrateConversation(raw map[string]any) (*Conversation, error) {
	if raw == nil {
		return nil, errors.New("invalid conversation data")
	}

	// v0 -> v1: add version field
	if _, ok := raw["version"]; !ok {
		raw["version"] = float64(1)
	}

	version, _ := raw["version"].(float64) //nolint:errcheck // missing/non-number version -> 0, handled below

	// v1 -> v2: convert flat messages to tree entries
	if version < 2 {
		var entries []SessionEntry
		var prevID *string

		if msgs, ok := raw["messages"].([]any); ok {
			for _, m := range msgs {
				msg, ok := m.(map[string]any)
				if !ok {
					continue
				}
				entryID := GenEntryID()
				entries = append(entries, SessionEntry{
					ID:        entryID,
					ParentID:  prevID,
					Type:      EntryMessage,
					Timestamp: int64(jsonFloat(raw, "createdAt", float64(nowMillis()))),
					Data: MessageData{
						Role:    jsonString(msg, "role"),
						Content: msg["content"],
					},
				})
				prevID = strPtr(entryID)
			}
		}

		raw["entries"] = entries
		raw["leafId"] = prevID
		raw["version"] = float64(2)
	}

	b, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("marshal during migration: %w", err)
	}
	var conv Conversation
	if err := json.Unmarshal(b, &conv); err != nil {
		return nil, fmt.Errorf("unmarshal during migration: %w", err)
	}

	if err := rehydrateEntries(&conv); err != nil {
		return nil, err
	}

	// Migrated trees get the same linkage validation as directly-loaded ones.
	validateAndRepairTree(&conv)

	return &conv, nil
}

// rehydrateEntries re-decodes entry.Data from map[string]any into typed structs.
func rehydrateEntries(conv *Conversation) error {
	for i := range conv.Entries {
		e := &conv.Entries[i]
		raw, ok := e.Data.(map[string]any)
		if !ok {
			continue
		}
		b, err := json.Marshal(raw)
		if err != nil {
			continue
		}
		switch e.Type {
		case EntryMessage:
			var md MessageData
			if err := json.Unmarshal(b, &md); err == nil {
				e.Data = md
			}
		case EntryCompaction:
			var cd CompactionData
			if err := json.Unmarshal(b, &cd); err == nil {
				e.Data = cd
			}
		case EntryLabel:
			var ld LabelData
			if err := json.Unmarshal(b, &ld); err == nil {
				e.Data = ld
			}
		case EntryModelChange:
			var mc ModelChangeData
			if err := json.Unmarshal(b, &mc); err == nil {
				e.Data = mc
			}
		case EntryAgentDispatch:
			var ad AgentDispatchData
			if err := json.Unmarshal(b, &ad); err == nil {
				e.Data = ad
			}
		}
	}
	return nil
}

// Save persists a conversation to disk using the split sidecar format:
//
//	<id>.llm.jsonl  — header + LLM messages (authoritative for context)
//	<id>.tree.jsonl — header + tree entries + leafId (rendering/branching)
//
// If the conversation was loaded from a legacy .jsonl file (_isLegacy == true),
// Save also removes the legacy file after both new sidecars are written
// successfully. Failure to unlink the legacy file is non-fatal and logged.
//
// For brand-new conversations with no entries (version < 2 or len(Entries)==0),
// Save falls back to the legacy saveJSON path so empty-conversation saves are
// still handled gracefully.
func Save(conv *Conversation, dir string) error {
	if dir == "" {
		dir = DefaultConversationsDir()
	}
	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	// One conversation spans two sidecars. Serialize the complete snapshot and
	// ordered pair replacement, not individual files, so concurrent saves cannot
	// interleave LLM/tree generations or clobber each other's snapshots.
	conv.lock()
	convID := conv.ID
	conv.unlock()
	lockPath := filepath.Join(dir, ".conversation-"+convID)
	return durablefile.Transaction(lockPath, 5*time.Second, func(_ string) error {
		conv.lock()
		split := conv.Version >= 2 && len(conv.Entries) > 0
		conv.unlock()
		if split {
			return saveSplit(conv, dir)
		}
		return saveJSON(conv, dir)
	})
}

// saveSplit writes the two sidecar files atomically in order:
//
//  1. <id>.llm.jsonl  — the LLM-authoritative context file
//  2. <id>.tree.jsonl — the rendering/branching tree
//
// Writing order matters for crash safety. If we crash between the two renames,
// the tree is one entry behind the LLM file. That is safe-direction: the LLM
// file is the authority for context correctness. The reverse (tree ahead of LLM)
// would be unsafe because the tree would imply the user "said" something the
// LLM never saw.
//
// Message body selection:
//   - When conv.Messages is nil (explicitly cleared by /clear): write header only
//     — no message lines. On reload, Messages == nil; LLM sees empty history.
//   - When conv.Messages is non-nil and Entries are present: write
//     BuildContextPath(conv) to derive the canonical message sequence from the
//     entry tree. This excludes transient messages (added via
//     AddTransientUserMessage) that are in conv.Messages but not in Entries.
//   - When conv.Messages is non-nil and no Entries: write conv.Messages as-is.
//
// After both writes succeed, any legacy .jsonl file is unlinked. Failure to
// unlink is non-fatal: the next Load will find the new pair and the next Save
// will retry the unlink.
func saveSplit(conv *Conversation, dir string) error {
	// Snapshot all tree/message state under the lock, then marshal and write
	// outside it — persistence must never serialize a half-applied append and
	// must never hold the tree lock across disk I/O. The entry snapshot is a
	// shallow copy: entry Data values are replaced wholesale by mutators
	// (never mutated in place), so the copied headers are stable.
	conv.lock()
	convID := conv.ID
	llmHeader := map[string]any{
		"meta":              true,
		"id":                conv.ID,
		"version":           conv.Version,
		"model":             conv.Model,
		"system":            conv.System,
		"totalInputTokens":  conv.TotalInputTokens,
		"totalOutputTokens": conv.TotalOutputTokens,
		"totalCost":         conv.TotalCost,
		"createdAt":         conv.CreatedAt,
	}
	if conv.ParentID != "" {
		llmHeader["parentId"] = conv.ParentID
	}
	if conv.Backend != "" {
		llmHeader["backend"] = conv.Backend
	}
	if conv.DispatchTranscriptMirror {
		llmHeader["dispatchTranscriptMirror"] = true
	}

	// Determine which messages to write:
	//   - nil Messages means explicitly cleared — write nothing (header only).
	//   - non-nil Messages with Entries: derive from the entry tree to exclude
	//     transient messages that are in conv.Messages but not in Entries.
	//   - non-nil Messages without Entries: write conv.Messages as-is.
	var messagesToWrite []types.LlmMessage
	if conv.Messages != nil {
		if len(conv.Entries) > 0 {
			messagesToWrite = buildContextPathLocked(conv)
		} else {
			messagesToWrite = conv.Messages
		}
	}

	entriesSnap := make([]SessionEntry, len(conv.Entries))
	copy(entriesSnap, conv.Entries)

	var leafSnap any
	if conv.LeafID != nil {
		leafSnap = *conv.LeafID
	}
	treeHeader := map[string]any{
		"meta":                  true,
		"id":                    conv.ID,
		"version":               conv.Version,
		"leafId":                leafSnap,
		"workingDirectory":      conv.WorkingDirectory,
		"recoveryRepairVersion": conv.RecoveryRepairVersion,
	}
	// Mirror the backend discriminator onto the tree header too: consumers
	// that only read the tree file (rendering/branching) can still assert the
	// history format without opening the llm file.
	if conv.Backend != "" {
		treeHeader["backend"] = conv.Backend
	}
	if conv.DispatchTranscriptMirror {
		treeHeader["dispatchTranscriptMirror"] = true
	}
	// Persist the per-provider native-session cursors (additive, omitted when
	// empty). The tree header is the natural home: cursors are position-tagged
	// against the tree's LeafID, and both live in the same file so a cursor
	// can never be persisted against a leaf it has not seen.
	if len(conv.NativeSessions) > 0 {
		nsSnap := make(map[string]NativeSessionCursor, len(conv.NativeSessions))
		for k, v := range conv.NativeSessions {
			nsSnap[k] = v
		}
		treeHeader["nativeSessions"] = nsSnap
	}
	if conv.ActiveRun != nil {
		activeRun := *conv.ActiveRun
		treeHeader["activeRun"] = activeRun
	}
	isLegacy := conv._isLegacy
	conv.unlock()

	llmPath := filepath.Join(dir, convID+".llm.jsonl")
	treePath := filepath.Join(dir, convID+".tree.jsonl")
	legacyPath := filepath.Join(dir, convID+".jsonl")

	// --- Build .llm.jsonl content: header + message body ---
	var llmLines []string
	llmHeaderBytes, err := json.Marshal(llmHeader)
	if err != nil {
		return fmt.Errorf("marshal llm header: %w", err)
	}
	llmLines = append(llmLines, string(llmHeaderBytes))

	// Write the selected messages as the .llm.jsonl body. Each assistant
	// message carries its API-reported Usage (set by AddAssistantMessage),
	// which GetContextUsage rehydrates and backward-scans on the next load —
	// no separate token-count scalar is persisted.
	for _, msg := range messagesToWrite {
		msgBytes, err := json.Marshal(msg)
		if err != nil {
			return fmt.Errorf("marshal llm message: %w", err)
		}
		llmLines = append(llmLines, string(msgBytes))
	}

	llmData := []byte(strings.Join(llmLines, "\n") + "\n")
	if err := writeFileSynced(llmPath, llmData); err != nil {
		utils.LogWithFields(utils.LevelInfo, "conversation", "save llm jsonl write failed", map[string]any{"conversation_id": convID, "error": err.Error()})
		return fmt.Errorf("save llm file: %w", err)
	}

	// --- Build .tree.jsonl content: header + Entries ---
	var treeLines []string
	treeHeaderBytes, err := json.Marshal(treeHeader)
	if err != nil {
		return fmt.Errorf("marshal tree header: %w", err)
	}
	treeLines = append(treeLines, string(treeHeaderBytes))

	for _, entry := range entriesSnap {
		entryBytes, err := json.Marshal(entry)
		if err != nil {
			return fmt.Errorf("marshal tree entry: %w", err)
		}
		treeLines = append(treeLines, string(entryBytes))
	}

	treeData := []byte(strings.Join(treeLines, "\n") + "\n")
	if err := writeFileSynced(treePath, treeData); err != nil {
		utils.LogWithFields(utils.LevelInfo, "conversation", "save tree jsonl write failed", map[string]any{"conversation_id": convID, "error": err.Error()})
		return fmt.Errorf("save tree file: %w", err)
	}

	// Determine log mode for observability.
	mode := "new"
	if isLegacy {
		mode = "migrate"
	}
	utils.LogWithFields(utils.LevelInfo, "conversation", "save", map[string]any{
		"conversation_id": convID, "reason": mode, "count": len(llmData), "max": len(treeData),
	})

	// Unlink legacy .jsonl after both new files are written. Non-fatal on
	// failure: both new files exist, so the next Load finds the new pair.
	// The next Save will retry the unlink because _isLegacy is set from the
	// on-disk probe, not from this field (which is in-memory only).
	if isLegacy {
		if unlinkErr := os.Remove(legacyPath); unlinkErr != nil && !os.IsNotExist(unlinkErr) {
			utils.LogWithFields(utils.LevelInfo, "conversation", "save migrate legacy unlink failed", map[string]any{"conversation_id": convID, "error": unlinkErr.Error()})
		} else if unlinkErr == nil {
			utils.LogWithFields(utils.LevelInfo, "conversation", "save migrate legacy removed", map[string]any{"conversation_id": convID, "path": convID + ".jsonl"})
		}
		// Clear the flag so repeated saves in the same process don't re-attempt
		// on an already-removed file.
		conv.lock()
		conv._isLegacy = false
		conv.unlock()
	}

	return nil
}

func saveJSON(conv *Conversation, dir string) error {
	savePath := filepath.Join(dir, conv.ID+".json")
	b, err := json.MarshalIndent(conv, "", "  ")
	if err != nil {
		return err
	}
	return writeFileSynced(savePath, b)
}

// writeFileSynced writes data to path with fsync, so a crash immediately
// after the write does not lose the contents. Uses a temp file + rename
// for atomicity, then fsyncs the parent directory so the rename is durable.
//
// The temp name is unique per call. A shared `path + ".tmp"` made concurrent
// writers of the same conversation destroy each other: both opened the same
// temp path, the first rename consumed it, and the second failed with ENOENT
// ("rename <id>.llm.jsonl.tmp: no such file or directory") after its data was
// already truncated away by the other writer's O_TRUNC. A dispatch fan-out hit
// this on every parallel registration.
func writeFileSynced(path string, data []byte) error {
	return durablefile.Write(path, data, 0o644)
}

// LoadLlmHeaderModel reads only the model field from a conversation's
// .llm.jsonl header without parsing any messages. This is a lightweight
// alternative to Load when only the model name is needed (e.g. listing
// conversations).
func LoadLlmHeaderModel(id, dir string) (string, error) {
	if dir == "" {
		dir = DefaultConversationsDir()
	}

	llmPath := filepath.Join(dir, id+".llm.jsonl")
	f, err := os.Open(llmPath)
	if err != nil {
		if os.IsNotExist(err) {
			return "", fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return "", fmt.Errorf("open llm file %s: %w", llmPath, err)
	}
	defer func() { f.Close() }() //nolint:errcheck // read-only file close

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)

	// Read only the first non-empty line (the header).
	var headerLine string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			headerLine = line
			break
		}
	}
	if err := scanner.Err(); err != nil {
		return "", fmt.Errorf("scan llm header %s: %w", llmPath, err)
	}
	if headerLine == "" {
		return "", fmt.Errorf("empty llm file: %s", llmPath)
	}

	var header map[string]any
	if err := json.Unmarshal([]byte(headerLine), &header); err != nil {
		return "", fmt.Errorf("invalid llm header in %s: %w", llmPath, err)
	}

	model := jsonString(header, "model")
	utils.LogWithFields(utils.LevelDebug, "conversation", "load llm header model", map[string]any{"conversation_id": id, "model": model})
	return model, nil
}

// Load reads a conversation from disk. Probe order:
//
//  1. <id>.llm.jsonl AND <id>.tree.jsonl both present → new split format.
//  2. <id>.jsonl present → legacy format (sets _isLegacy; migrated on next Save).
//  3. <id>.json present → v1 JSON migration path (also legacy-flagged).
//  4. Else → not found.
//
// The split probe requires BOTH files to be present. If only .llm.jsonl exists
// (e.g. a mid-migration crash left an orphan), Load falls through to the legacy
// probe. The orphan is overwritten on the next Save.
func Load(id, dir string) (*Conversation, error) {
	return load(id, dir, true)
}

// load is the internal variant used by UpdateOnDisk. Its repair persistence is
// disabled under the per-conversation lock because re-entering that lock would
// deadlock. The enclosing transaction saves the marked conversation instead.
func load(id, dir string, persistRepair bool) (*Conversation, error) {
	if dir == "" {
		dir = DefaultConversationsDir()
	}

	llmPath := filepath.Join(dir, id+".llm.jsonl")
	treePath := filepath.Join(dir, id+".tree.jsonl")
	jsonlPath := filepath.Join(dir, id+".jsonl")
	jsonPath := filepath.Join(dir, id+".json")

	// Probe 1: new split format — both files must exist.
	_, llmErr := os.Stat(llmPath)
	_, treeErr := os.Stat(treePath)
	if llmErr == nil && treeErr == nil {
		conv, err := loadSplit(id, llmPath, treePath)
		if err != nil {
			return nil, err
		}
		if persistRepair {
			persistRecoveryRepairIfNeeded(conv, dir)
		}
		return conv, nil
	}

	// Probe 2: legacy .jsonl
	if data, err := os.ReadFile(jsonlPath); err == nil {
		conv, err := loadFromJSONL(data)
		if err != nil {
			return nil, err
		}
		conv._isLegacy = true
		if persistRepair {
			persistRecoveryRepairIfNeeded(conv, dir)
		}
		utils.LogWithFields(utils.LevelInfo, "conversation", "load legacy will migrate on next save", map[string]any{
			"conversation_id": conv.ID, "count": len(conv.Entries), "max": len(conv.Messages),
		})
		return conv, nil
	}

	// Probe 3: v1 JSON migration
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, "conversation", "load not found", map[string]any{"conversation_id": id})
		return nil, fmt.Errorf("%w: %s", ErrNotFound, id)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	conv, err := MigrateConversation(raw)
	if err != nil {
		return nil, err
	}
	conv._isLegacy = true
	if persistRepair {
		persistRecoveryRepairIfNeeded(conv, dir)
	}
	utils.LogWithFields(utils.LevelInfo, "conversation", "load v1json will migrate on next save", map[string]any{
		"conversation_id": conv.ID, "count": len(conv.Entries), "max": len(conv.Messages),
	})
	return conv, nil
}

// Exists reports whether a conversation with the given ID has a backing file
// on disk, without parsing it. The probe order mirrors Load:
//
//  1. <id>.llm.jsonl AND <id>.tree.jsonl both present → new split format.
//  2. <id>.jsonl present → legacy format.
//  3. <id>.json present → v1 JSON format.
//
// This is the cheap existence check used by resolve-time guards that must
// decide whether an id names a resumable conversation BEFORE committing the
// session to it. A "phantom" id — one that was pre-minted and never saved —
// returns false here, so callers can fall through to a fresh mint instead of
// silently starting an empty session bound to a fileless id. (#230/#231)
//
// Like Load, an empty dir resolves to ~/.ion/conversations.
func Exists(id, dir string) bool {
	if id == "" {
		return false
	}
	if dir == "" {
		dir = DefaultConversationsDir()
	}

	// Probe 1: new split format — both files must exist (matches Load's
	// requirement that an orphan .llm.jsonl alone is NOT a valid split).
	_, llmErr := os.Stat(filepath.Join(dir, id+".llm.jsonl"))
	_, treeErr := os.Stat(filepath.Join(dir, id+".tree.jsonl"))
	if llmErr == nil && treeErr == nil {
		return true
	}

	// Probe 2: legacy .jsonl
	if _, err := os.Stat(filepath.Join(dir, id+".jsonl")); err == nil {
		return true
	}

	// Probe 3: v1 .json
	if _, err := os.Stat(filepath.Join(dir, id+".json")); err == nil {
		return true
	}

	return false
}

// loadSplit reads both sidecar files and merges them into a single Conversation.
//
// Field sourcing:
//   - Header metadata (ID, Model, System, token counters, cost, etc.) — from .llm.jsonl.
//   - Messages (LLM context) — from .llm.jsonl body lines. NOT rebuilt via
//     BuildContextPath; whatever is in the file is the authoritative LLM context.
//   - Entries, LeafID, WorkingDirectory — from .tree.jsonl.
//
// This is the critical correctness guarantee: /clear zeros Messages and saves
// .llm.jsonl with an empty body. On the next Load, Messages == nil because
// we trust the file, not because we re-derive from Entries.
func loadSplit(id, llmPath, treePath string) (*Conversation, error) {
	// --- Parse .llm.jsonl ---
	llmData, err := os.ReadFile(llmPath)
	if err != nil {
		return nil, fmt.Errorf("read llm file %s: %w", llmPath, err)
	}

	llmLines, err := scanNonEmptyLines(llmData)
	if err != nil {
		return nil, fmt.Errorf("scan llm file %s: %w", llmPath, err)
	}
	if len(llmLines) == 0 {
		return nil, fmt.Errorf("empty llm file: %s", llmPath)
	}

	var llmHeader map[string]any
	if err := json.Unmarshal([]byte(llmLines[0]), &llmHeader); err != nil {
		return nil, fmt.Errorf("invalid llm header in %s: %w", llmPath, err)
	}
	if _, ok := llmHeader["meta"]; !ok {
		return nil, fmt.Errorf("missing meta field in llm header: %s", llmPath)
	}

	var messages []types.LlmMessage
	for i := 1; i < len(llmLines); i++ {
		var msg types.LlmMessage
		if err := json.Unmarshal([]byte(llmLines[i]), &msg); err != nil {
			return nil, fmt.Errorf("invalid message at line %d in %s: %w", i+1, llmPath, err)
		}
		messages = append(messages, msg)
	}

	// --- Parse .tree.jsonl ---
	treeData, err := os.ReadFile(treePath)
	if err != nil {
		return nil, fmt.Errorf("read tree file %s: %w", treePath, err)
	}

	treeLines, err := scanNonEmptyLines(treeData)
	if err != nil {
		return nil, fmt.Errorf("scan tree file %s: %w", treePath, err)
	}
	if len(treeLines) == 0 {
		return nil, fmt.Errorf("empty tree file: %s", treePath)
	}

	var treeHeader map[string]any
	if err := json.Unmarshal([]byte(treeLines[0]), &treeHeader); err != nil {
		return nil, fmt.Errorf("invalid tree header in %s: %w", treePath, err)
	}
	if _, ok := treeHeader["meta"]; !ok {
		return nil, fmt.Errorf("missing meta field in tree header: %s", treePath)
	}

	var entries []SessionEntry
	for i := 1; i < len(treeLines); i++ {
		var entry SessionEntry
		if err := json.Unmarshal([]byte(treeLines[i]), &entry); err != nil {
			return nil, fmt.Errorf("invalid entry at line %d in %s: %w", i+1, treePath, err)
		}
		entries = append(entries, entry)
	}

	// --- Merge into Conversation ---
	conv := &Conversation{
		// Header fields from .llm.jsonl (canonical metadata source)
		ID:                jsonString(llmHeader, "id"),
		System:            jsonString(llmHeader, "system"),
		Model:             jsonString(llmHeader, "model"),
		TotalInputTokens:  int(jsonFloat(llmHeader, "totalInputTokens", 0)),
		TotalOutputTokens: int(jsonFloat(llmHeader, "totalOutputTokens", 0)),
		TotalCost:         jsonFloat(llmHeader, "totalCost", 0),
		CreatedAt:         int64(jsonFloat(llmHeader, "createdAt", float64(nowMillis()))),
		Version:           int(jsonFloat(llmHeader, "version", 2)),
		ParentID:          jsonString(llmHeader, "parentId"),
		// Backend discriminator (additive). Legacy headers without the field
		// decode "" — treated as api by consumers.
		Backend:                  jsonString(llmHeader, "backend"),
		DispatchTranscriptMirror: jsonBool(llmHeader, "dispatchTranscriptMirror"),
		// LLM context from .llm.jsonl body — verbatim, NOT rebuilt from Entries
		Messages: messages,
		// Tree fields from .tree.jsonl
		Entries:          entries,
		WorkingDirectory: jsonString(treeHeader, "workingDirectory"),
	}

	if leafID, ok := treeHeader["leafId"].(string); ok {
		conv.LeafID = &leafID
	}

	// Rehydrate the per-provider native-session cursors (additive header
	// field; absent on legacy files). Round-trip through JSON so the untyped
	// header map decodes into the typed cursor struct; a malformed field is
	// logged and dropped rather than failing the whole load — cursors are a
	// disposable cache, and the safe fallback is "no cursor → re-bridge".
	if rawNS, ok := treeHeader["nativeSessions"]; ok && rawNS != nil {
		nsBytes, err := json.Marshal(rawNS)
		if err == nil {
			var ns map[string]NativeSessionCursor
			if err = json.Unmarshal(nsBytes, &ns); err == nil && len(ns) > 0 {
				conv.NativeSessions = ns
			}
		}
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "conversation", "load: dropping malformed nativeSessions header", map[string]any{
				"conversation_id": conv.ID, "error": err.Error(),
			})
		}
	}

	decodeTreeHeaderRecovery(conv, treeHeader)

	if err := rehydrateEntries(conv); err != nil {
		return nil, err
	}
	if repairLegacyRecoveryState(conv) {
		utils.LogWithFields(utils.LevelInfo, "conversation.recovery_repair", "legacy recovery content repaired in memory", map[string]any{"conversation_id": conv.ID})
	}

	// Validate and repair the tree linkage before anything walks it — a
	// dangling parent otherwise silently truncates history at the gap. The
	// repaired shape persists on the next Save, healing the file in place.
	repairReport := validateAndRepairTree(conv)
	if repairReport.InvalidCompactionsRepaired > 0 {
		conv.Messages = BuildContextPath(conv)
		utils.LogWithFields(utils.LevelWarn, "conversation", "recovered provider context after invalid compaction repair", map[string]any{
			"conversation_id":           conv.ID,
			"repaired_compactions":      repairReport.InvalidCompactionsRepaired,
			"rebuilt_provider_messages": len(conv.Messages),
			"transcript_rows":           len(flattenEntries(conv)),
		})
	}

	utils.LogWithFields(utils.LevelInfo, "conversation", "load new", map[string]any{
		"conversation_id": conv.ID, "count": len(conv.Entries), "max": len(conv.Messages),
	})
	rehydrateMessageUsage(conv)
	return conv, nil
}

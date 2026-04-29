package conversation

import (
	"bufio"
	"crypto/rand"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"math"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// CurrentVersion is the schema version for new conversations.
const CurrentVersion = 2

// DefaultContext is the default context window size in tokens.
const DefaultContext = 200000

// SessionEntryType identifies the kind of tree entry.
type SessionEntryType string

const (
	EntryMessage     SessionEntryType = "message"
	EntryCompaction  SessionEntryType = "compaction"
	EntryModelChange SessionEntryType = "model_change"
	EntryLabel       SessionEntryType = "label"
	EntryCustom      SessionEntryType = "custom"
)

// MessageData holds a chat message entry.
type MessageData struct {
	Role    string         `json:"role"`
	Content any            `json:"content"` // string or []types.LlmContentBlock
	Usage   *types.LlmUsage `json:"usage,omitempty"`
}

// CompactionData holds metadata about a compaction event.
type CompactionData struct {
	Summary          string `json:"summary"`
	FirstKeptEntryID string `json:"firstKeptEntryId"`
	TokensBefore     int    `json:"tokensBefore"`
}

// LabelData holds a label annotation on an entry.
type LabelData struct {
	TargetID string  `json:"targetId"`
	Label    *string `json:"label"`
}

// ModelChangeData records a model switch.
type ModelChangeData struct {
	Model         string `json:"model"`
	PreviousModel string `json:"previousModel,omitempty"`
}

// SessionEntry is a single node in the conversation tree.
type SessionEntry struct {
	ID        string           `json:"id"`
	ParentID  *string          `json:"parentId"`
	Type      SessionEntryType `json:"type"`
	Timestamp int64            `json:"timestamp"`
	Data      any              `json:"data"`
}

// TreeNode is a tree representation of entries for visualization.
type TreeNode struct {
	Entry    SessionEntry `json:"entry"`
	Children []TreeNode   `json:"children"`
}

// Conversation is the top-level session object.
type Conversation struct {
	ID                string             `json:"id"`
	System            string             `json:"system"`
	Model             string             `json:"model"`
	Messages          []types.LlmMessage `json:"messages"`
	TotalInputTokens  int                `json:"totalInputTokens"`
	TotalOutputTokens int                `json:"totalOutputTokens"`
	LastInputTokens         int                `json:"lastInputTokens"`
	LastInputTokensMsgCount int                `json:"lastInputTokensMsgCount,omitempty"`
	TotalCost         float64            `json:"totalCost"`
	CreatedAt         int64              `json:"createdAt"`
	Version           int                `json:"version,omitempty"`
	ParentID          string             `json:"parentId,omitempty"`
	Entries           []SessionEntry     `json:"entries,omitempty"`
	LeafID            *string            `json:"leafId"`
}

// ContextUsageInfo describes current context window consumption.
type ContextUsageInfo struct {
	Percent   int  `json:"percent"`
	Tokens    int  `json:"tokens"`
	Limit     int  `json:"limit"`
	Estimated bool `json:"estimated"`
}

// ToolResultEntry is a tool result to add as a user message.
type ToolResultEntry struct {
	ToolUseID string `json:"tool_use_id"`
	Content   string `json:"content"`
	IsError   bool   `json:"is_error,omitempty"`
}

// ContextFile is a discovered context file on disk.
type ContextFile struct {
	Path    string
	Content string
}

// GenEntryID generates an 8-character hex ID from crypto/rand.
func GenEntryID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		panic("crypto/rand failed: " + err.Error())
	}
	return hex.EncodeToString(b)
}

func nowMillis() int64 {
	return time.Now().UnixMilli()
}

// textBlock creates a text content block.
func textBlock(text string) types.LlmContentBlock {
	return types.LlmContentBlock{Type: "text", Text: text}
}

// CreateConversation initializes a new v2 conversation.
func CreateConversation(id, system, model string) *Conversation {
	return &Conversation{
		ID:        id,
		System:    system,
		Model:     model,
		Messages:  []types.LlmMessage{},
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		Entries:   []SessionEntry{},
		LeafID:    nil,
	}
}

// MigrateConversation upgrades a raw JSON map to the current schema version.
func MigrateConversation(raw map[string]any) (*Conversation, error) {
	if raw == nil {
		return nil, errors.New("invalid conversation data")
	}

	// v0 -> v1: add version field
	if _, ok := raw["version"]; !ok {
		raw["version"] = float64(1)
	}

	version, _ := raw["version"].(float64)

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

	// Marshal and unmarshal into Conversation struct
	b, err := json.Marshal(raw)
	if err != nil {
		return nil, fmt.Errorf("marshal during migration: %w", err)
	}
	var conv Conversation
	if err := json.Unmarshal(b, &conv); err != nil {
		return nil, fmt.Errorf("unmarshal during migration: %w", err)
	}

	// Re-decode entry data into typed structs
	if err := rehydrateEntries(&conv); err != nil {
		return nil, err
	}

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
		}
	}
	return nil
}

// AddUserMessage appends a user message to the conversation.
func AddUserMessage(conv *Conversation, content any) {
	var blocks []types.LlmContentBlock
	switch c := content.(type) {
	case string:
		blocks = []types.LlmContentBlock{textBlock(c)}
	case []types.LlmContentBlock:
		blocks = c
	default:
		blocks = []types.LlmContentBlock{textBlock(fmt.Sprint(c))}
	}

	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
	}
}

// AddAssistantMessage appends an assistant message with usage tracking.
func AddAssistantMessage(conv *Conversation, blocks []types.LlmContentBlock, usage types.LlmUsage) {
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "assistant", Content: blocks})
	// Track total context size including cached tokens. The API's input_tokens
	// field only counts non-cached tokens; cache_read and cache_creation must
	// be added to get the actual context window consumption.
	totalInput := usage.InputTokens + usage.CacheReadInputTokens + usage.CacheCreationInputTokens
	conv.TotalInputTokens += totalInput
	conv.TotalOutputTokens += usage.OutputTokens
	conv.LastInputTokens = totalInput
	conv.LastInputTokensMsgCount = len(conv.Messages)

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "assistant", Content: blocks, Usage: &usage})
	}
}

// AddToolResults appends tool results as a user message with tool_result content blocks.
func AddToolResults(conv *Conversation, results []ToolResultEntry) {
	blocks := make([]types.LlmContentBlock, len(results))
	for i, r := range results {
		isErr := r.IsError
		blocks[i] = types.LlmContentBlock{
			Type:      "tool_result",
			ToolUseID: r.ToolUseID,
			Content:   r.Content,
			IsError:   &isErr,
		}
	}
	conv.Messages = append(conv.Messages, types.LlmMessage{Role: "user", Content: blocks})

	if conv.Entries != nil {
		AppendEntry(conv, EntryMessage, MessageData{Role: "user", Content: blocks})
	}
}

// UpdateCost adds to the running cost total.
func UpdateCost(conv *Conversation, costUsd float64) {
	conv.TotalCost += costUsd
}

// AppendEntry adds an entry to the tree, chained from the current leaf.
func AppendEntry(conv *Conversation, entryType SessionEntryType, data any) *SessionEntry {
	if conv.Entries == nil {
		conv.Entries = []SessionEntry{}
	}
	entry := SessionEntry{
		ID:        GenEntryID(),
		ParentID:  conv.LeafID,
		Type:      entryType,
		Timestamp: nowMillis(),
		Data:      data,
	}
	conv.Entries = append(conv.Entries, entry)
	conv.LeafID = &conv.Entries[len(conv.Entries)-1].ID
	return &conv.Entries[len(conv.Entries)-1]
}

// Branch moves the leaf pointer to an existing entry and rebuilds the message list.
func Branch(conv *Conversation, entryID string) ([]types.LlmMessage, error) {
	if conv.Entries == nil {
		return conv.Messages, nil
	}
	found := false
	for _, e := range conv.Entries {
		if e.ID == entryID {
			found = true
			break
		}
	}
	if !found {
		return nil, fmt.Errorf("entry not found: %s", entryID)
	}
	conv.LeafID = &entryID
	conv.Messages = BuildContextPath(conv)
	return conv.Messages, nil
}

// BuildContextPath walks from the current leaf to the root and extracts messages.
func BuildContextPath(conv *Conversation) []types.LlmMessage {
	if conv.Entries == nil || conv.LeafID == nil {
		return conv.Messages
	}

	entryMap := buildEntryMap(conv.Entries)

	// Walk leaf to root
	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	for ok {
		path = append(path, current)
		if current.ParentID != nil {
			current, ok = entryMap[*current.ParentID]
		} else {
			ok = false
		}
	}

	// Reverse to get root-first order
	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}

	var messages []types.LlmMessage
	for _, entry := range path {
		switch entry.Type {
		case EntryMessage:
			md := asMessageData(entry.Data)
			if md != nil {
				messages = append(messages, types.LlmMessage{Role: md.Role, Content: md.Content})
			}
		case EntryCompaction:
			cd := asCompactionData(entry.Data)
			if cd != nil {
				messages = append(messages, types.LlmMessage{
					Role:    "user",
					Content: []types.LlmContentBlock{textBlock("[Previous conversation summary]: " + cd.Summary)},
				})
			}
		}
	}
	return messages
}

// NavigateTree moves the leaf pointer to target and rebuilds messages.
func NavigateTree(conv *Conversation, targetID string) ([]types.LlmMessage, error) {
	return Branch(conv, targetID)
}

// GetTree builds the full tree structure for visualization.
func GetTree(conv *Conversation) []TreeNode {
	if len(conv.Entries) == 0 {
		return nil
	}

	// Build children map keyed by parent ID ("" for nil parent)
	childMap := make(map[string][]SessionEntry)
	for _, entry := range conv.Entries {
		key := ""
		if entry.ParentID != nil {
			key = *entry.ParentID
		}
		childMap[key] = append(childMap[key], entry)
	}

	var buildNode func(SessionEntry) TreeNode
	buildNode = func(entry SessionEntry) TreeNode {
		children := childMap[entry.ID]
		nodes := make([]TreeNode, len(children))
		for i, child := range children {
			nodes[i] = buildNode(child)
		}
		return TreeNode{Entry: entry, Children: nodes}
	}

	roots := childMap[""]
	result := make([]TreeNode, len(roots))
	for i, r := range roots {
		result[i] = buildNode(r)
	}
	return result
}

// GetBranchPoints returns entries that have more than one child.
func GetBranchPoints(conv *Conversation) []SessionEntry {
	if len(conv.Entries) == 0 {
		return nil
	}

	childCount := make(map[string]int)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			childCount[*e.ParentID]++
		}
	}

	entryMap := buildEntryMap(conv.Entries)
	var result []SessionEntry
	for id, count := range childCount {
		if count > 1 {
			if e, ok := entryMap[id]; ok {
				result = append(result, e)
			}
		}
	}
	return result
}

// GetLeaves returns entries with no children.
func GetLeaves(conv *Conversation) []SessionEntry {
	if len(conv.Entries) == 0 {
		return nil
	}

	hasChildren := make(map[string]bool)
	for _, e := range conv.Entries {
		if e.ParentID != nil {
			hasChildren[*e.ParentID] = true
		}
	}

	var result []SessionEntry
	for _, e := range conv.Entries {
		if !hasChildren[e.ID] {
			result = append(result, e)
		}
	}
	return result
}

// EstimateTokens provides a heuristic token count.
// Strings: ~4 chars/token. Structured content: ~3.5 chars/token (JSON overhead).
func EstimateTokens(content any) int {
	switch c := content.(type) {
	case string:
		return int(math.Ceil(float64(len(c)) / 4.0))
	default:
		b, err := json.Marshal(c)
		if err != nil {
			return 0
		}
		return int(math.Ceil(float64(len(b)) / 3.5))
	}
}

// GetContextUsage computes context window consumption. When LastInputTokens
// is available (from the previous API response), it adds an estimate for any
// messages added since (e.g. tool results) so the count isn't stale.
func GetContextUsage(conv *Conversation, contextWindow int) ContextUsageInfo {
	limit := contextWindow
	if limit <= 0 {
		limit = DefaultContext
	}

	reported := conv.LastInputTokens
	if reported > 0 {
		total := reported
		// Estimate tokens for messages added after the last API response
		if conv.LastInputTokensMsgCount > 0 && len(conv.Messages) > conv.LastInputTokensMsgCount {
			for _, msg := range conv.Messages[conv.LastInputTokensMsgCount:] {
				total += EstimateTokens(msg.Content)
			}
		}
		pct := int(math.Min(100, math.Round(float64(total)/float64(limit)*100)))
		return ContextUsageInfo{Percent: pct, Tokens: total, Limit: limit, Estimated: false}
	}

	estimated := EstimateTokens(conv.Messages)
	pct := int(math.Min(100, math.Round(float64(estimated)/float64(limit)*100)))
	return ContextUsageInfo{Percent: pct, Tokens: estimated, Limit: limit, Estimated: true}
}

// Compact drops the oldest messages, keeping keepTurns user+assistant pairs.
func Compact(conv *Conversation, keepTurns int) {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := 0
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}
	if cutIdx > 0 {
		conv.Messages = conv.Messages[cutIdx:]
	}
}

// CompactWithSummary summarizes older messages via the provided function, then drops them.
func CompactWithSummary(conv *Conversation, summarize func(string) (string, error), keepTurns int) error {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := 0
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}
	if cutIdx <= 0 {
		return nil
	}

	toDrop := conv.Messages[:cutIdx]

	var textParts []string
	for _, msg := range toDrop {
		text := extractText(msg)
		if text != "" {
			textParts = append(textParts, "["+msg.Role+"]: "+text)
		}
	}

	if len(textParts) == 0 {
		Compact(conv, keepTurns)
		return nil
	}

	summary, err := summarize(strings.Join(textParts, "\n\n"))
	if err != nil {
		Compact(conv, keepTurns)
		return err
	}

	conv.Messages = conv.Messages[cutIdx:]
	summaryMsg := types.LlmMessage{
		Role:    "user",
		Content: []types.LlmContentBlock{textBlock("[Previous conversation summary]: " + summary)},
	}
	conv.Messages = append([]types.LlmMessage{summaryMsg}, conv.Messages...)
	return nil
}

// MicroCompact progressively shrinks older messages to reduce context size.
// Pass 1: replaces tool_result content >100 chars with "[cleared]".
// Pass 2 (when pass 1 returns 0): also truncates long assistant text blocks.
// Returns the number of blocks modified.
func MicroCompact(conv *Conversation, keepTurns int) int {
	if keepTurns <= 0 {
		keepTurns = 10
	}

	pairs := 0
	cutIdx := len(conv.Messages)
	for i := len(conv.Messages) - 1; i >= 0; i-- {
		if conv.Messages[i].Role == "user" {
			pairs++
		}
		if pairs >= keepTurns {
			cutIdx = i
			break
		}
	}

	// Pass 1: clear long tool results
	cleared := 0
	for i := 0; i < cutIdx; i++ {
		msg := &conv.Messages[i]
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for j := range blocks {
			if blocks[j].Type == "tool_result" && len(blocks[j].Content) > 100 {
				blocks[j].Content = "[cleared]"
				cleared++
			}
		}
	}
	if cleared > 0 {
		return cleared
	}

	// Pass 2: truncate long assistant text blocks in old messages
	for i := 0; i < cutIdx; i++ {
		msg := &conv.Messages[i]
		if msg.Role != "assistant" {
			continue
		}
		blocks, ok := msg.Content.([]types.LlmContentBlock)
		if !ok {
			continue
		}
		for j := range blocks {
			if blocks[j].Type == "text" && len(blocks[j].Text) > 200 {
				blocks[j].Text = blocks[j].Text[:200] + "... [truncated]"
				cleared++
			}
		}
	}
	return cleared
}

// ForkConversation forks at a message index. For v2 trees, uses branch in-place.
// For legacy v1 conversations, creates a new conversation with copied messages.
func ForkConversation(conv *Conversation, atMessageIndex int) *Conversation {
	if len(conv.Entries) > 0 {
		// v2 tree: branch to the entry at the given message index
		path := getContextPathEntries(conv)
		var messageEntries []SessionEntry
		for _, e := range path {
			if e.Type == EntryMessage {
				messageEntries = append(messageEntries, e)
			}
		}
		idx := atMessageIndex
		if idx >= len(messageEntries) {
			idx = len(messageEntries) - 1
		}
		if idx >= 0 && idx < len(messageEntries) {
			Branch(conv, messageEntries[idx].ID)
		}
		return conv
	}

	// Legacy v1 fork
	newID := fmt.Sprintf("fork-%s-%d", conv.ID, nowMillis())
	idx := atMessageIndex
	if idx >= len(conv.Messages) {
		idx = len(conv.Messages) - 1
	}
	if idx < 0 {
		idx = 0
	}

	forked := make([]types.LlmMessage, idx+1)
	for i := 0; i <= idx; i++ {
		forked[i] = types.LlmMessage{
			Role:    conv.Messages[i].Role,
			Content: conv.Messages[i].Content,
		}
	}

	return &Conversation{
		ID:        newID,
		System:    conv.System,
		Model:     conv.Model,
		Messages:  forked,
		CreatedAt: nowMillis(),
		Version:   CurrentVersion,
		ParentID:  conv.ID,
		LeafID:    nil,
	}
}

// Save persists a conversation to disk. v2+ uses JSONL, v1 uses JSON.
func Save(conv *Conversation, dir string) error {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	if err := os.MkdirAll(dir, 0o755); err != nil {
		return err
	}

	if conv.Version >= 2 && len(conv.Entries) > 0 {
		return saveJSONL(conv, dir)
	}
	return saveJSON(conv, dir)
}

func saveJSONL(conv *Conversation, dir string) error {
	savePath := filepath.Join(dir, conv.ID+".jsonl")

	header := map[string]any{
		"meta":              true,
		"id":                conv.ID,
		"version":           conv.Version,
		"model":             conv.Model,
		"system":            conv.System,
		"totalInputTokens":  conv.TotalInputTokens,
		"totalOutputTokens": conv.TotalOutputTokens,
		"lastInputTokens":   conv.LastInputTokens,
		"totalCost":         conv.TotalCost,
		"createdAt":         conv.CreatedAt,
		"leafId":            conv.LeafID,
	}
	if conv.ParentID != "" {
		header["parentId"] = conv.ParentID
	}

	var lines []string
	headerBytes, err := json.Marshal(header)
	if err != nil {
		return err
	}
	lines = append(lines, string(headerBytes))

	for _, entry := range conv.Entries {
		entryBytes, err := json.Marshal(entry)
		if err != nil {
			return err
		}
		lines = append(lines, string(entryBytes))
	}

	return writeFileSynced(savePath, []byte(strings.Join(lines, "\n")+"\n"))
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
func writeFileSynced(path string, data []byte) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o644)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		os.Remove(tmp)
		return err
	}
	if err := f.Close(); err != nil {
		os.Remove(tmp)
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		os.Remove(tmp)
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		_ = dir.Close()
	}
	return nil
}

// Load reads a conversation from disk. Tries JSONL first, then JSON.
func Load(id, dir string) (*Conversation, error) {
	if dir == "" {
		home, err := os.UserHomeDir()
		if err != nil {
			return nil, err
		}
		dir = filepath.Join(home, ".ion", "conversations")
	}

	// Try JSONL first
	jsonlPath := filepath.Join(dir, id+".jsonl")
	if data, err := os.ReadFile(jsonlPath); err == nil {
		return loadFromJSONL(data)
	}

	// Fall back to JSON
	jsonPath := filepath.Join(dir, id+".json")
	data, err := os.ReadFile(jsonPath)
	if err != nil {
		return nil, fmt.Errorf("conversation not found: %s", id)
	}

	var raw map[string]any
	if err := json.Unmarshal(data, &raw); err != nil {
		return nil, err
	}
	return MigrateConversation(raw)
}

func loadFromJSONL(data []byte) (*Conversation, error) {
	scanner := bufio.NewScanner(strings.NewReader(string(data)))
	scanner.Buffer(make([]byte, 0, 64*1024), 1024*1024)
	var lines []string
	for scanner.Scan() {
		line := strings.TrimSpace(scanner.Text())
		if line != "" {
			lines = append(lines, line)
		}
	}
	if len(lines) == 0 {
		return nil, errors.New("empty JSONL")
	}

	var header map[string]any
	if err := json.Unmarshal([]byte(lines[0]), &header); err != nil {
		return nil, fmt.Errorf("invalid JSONL header: %w", err)
	}
	if _, ok := header["meta"]; !ok {
		return nil, errors.New("invalid JSONL header: missing meta field")
	}

	var entries []SessionEntry
	for i := 1; i < len(lines); i++ {
		var entry SessionEntry
		if err := json.Unmarshal([]byte(lines[i]), &entry); err != nil {
			return nil, fmt.Errorf("invalid entry at line %d: %w", i+1, err)
		}
		entries = append(entries, entry)
	}

	conv := &Conversation{
		ID:                jsonString(header, "id"),
		System:            jsonString(header, "system"),
		Model:             jsonString(header, "model"),
		Messages:          []types.LlmMessage{},
		TotalInputTokens:  int(jsonFloat(header, "totalInputTokens", 0)),
		TotalOutputTokens: int(jsonFloat(header, "totalOutputTokens", 0)),
		LastInputTokens:   int(jsonFloat(header, "lastInputTokens", 0)),
		TotalCost:         jsonFloat(header, "totalCost", 0),
		CreatedAt:         int64(jsonFloat(header, "createdAt", float64(nowMillis()))),
		Version:           int(jsonFloat(header, "version", 2)),
		ParentID:          jsonString(header, "parentId"),
		Entries:           entries,
	}

	if leafID, ok := header["leafId"].(string); ok {
		conv.LeafID = &leafID
	}

	// Re-decode entry data into typed structs
	if err := rehydrateEntries(conv); err != nil {
		return nil, err
	}

	conv.Messages = BuildContextPath(conv)
	return conv, nil
}

// DiscoverContextFiles walks parent directories looking for context files.
// Deprecated: use walkContextFiles from the context package instead.
func DiscoverContextFiles(cwd string, names []string) []ContextFile {
	if len(names) == 0 {
		names = []string{"CLAUDE.md", "ION.md", ".claude/CLAUDE.md", ".ion/ION.md"}
	}

	var results []ContextFile
	seen := make(map[string]bool)

	dir, err := filepath.Abs(cwd)
	if err != nil {
		return nil
	}

	for {
		for _, name := range names {
			fp := filepath.Join(dir, name)
			if seen[fp] {
				continue
			}
			seen[fp] = true

			data, err := os.ReadFile(fp)
			if err != nil {
				continue
			}
			results = append(results, ContextFile{Path: fp, Content: string(data)})
		}

		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}

	return results
}

// EncodeImage reads an image file and returns it as a base64 content block.
func EncodeImage(filePath string) (*types.LlmContentBlock, error) {
	supportedMime := map[string]string{
		".jpg":  "image/jpeg",
		".jpeg": "image/jpeg",
		".png":  "image/png",
		".webp": "image/webp",
		".gif":  "image/gif",
	}

	ext := strings.ToLower(filepath.Ext(filePath))
	mimeType, ok := supportedMime[ext]
	if !ok {
		supported := make([]string, 0, len(supportedMime))
		for k := range supportedMime {
			supported = append(supported, k)
		}
		return nil, fmt.Errorf("unsupported image format: %s. Supported: %s", ext, strings.Join(supported, ", "))
	}

	data, err := os.ReadFile(filePath)
	if err != nil {
		return nil, err
	}

	const maxSize = 20 * 1024 * 1024
	if len(data) > maxSize {
		return nil, fmt.Errorf("image too large: %.1fMB (max 20MB)", float64(len(data))/(1024*1024))
	}

	block := types.LlmContentBlock{
		Type: "image",
		Source: &types.ImageSource{
			Type:      "base64",
			MediaType: mimeType,
			Data:      base64.StdEncoding.EncodeToString(data),
		},
	}
	return &block, nil
}

// --- internal helpers ---

func buildEntryMap(entries []SessionEntry) map[string]SessionEntry {
	m := make(map[string]SessionEntry, len(entries))
	for _, e := range entries {
		m[e.ID] = e
	}
	return m
}

func getContextPathEntries(conv *Conversation) []SessionEntry {
	if conv.Entries == nil || conv.LeafID == nil {
		return nil
	}
	entryMap := buildEntryMap(conv.Entries)

	var path []SessionEntry
	current, ok := entryMap[*conv.LeafID]
	for ok {
		path = append(path, current)
		if current.ParentID != nil {
			current, ok = entryMap[*current.ParentID]
		} else {
			ok = false
		}
	}

	for i, j := 0, len(path)-1; i < j; i, j = i+1, j-1 {
		path[i], path[j] = path[j], path[i]
	}
	return path
}

func asMessageData(data any) *MessageData {
	switch d := data.(type) {
	case MessageData:
		return &d
	case *MessageData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var md MessageData
		if json.Unmarshal(b, &md) == nil {
			return &md
		}
	}
	return nil
}

func asCompactionData(data any) *CompactionData {
	switch d := data.(type) {
	case CompactionData:
		return &d
	case *CompactionData:
		return d
	case map[string]any:
		b, _ := json.Marshal(d)
		var cd CompactionData
		if json.Unmarshal(b, &cd) == nil {
			return &cd
		}
	}
	return nil
}

func extractText(msg types.LlmMessage) string {
	switch c := msg.Content.(type) {
	case string:
		return c
	case []types.LlmContentBlock:
		var parts []string
		for _, b := range c {
			if b.Type == "text" && b.Text != "" {
				parts = append(parts, b.Text)
			}
		}
		return strings.Join(parts, "\n")
	case []any:
		var parts []string
		for _, item := range c {
			if b, ok := item.(map[string]any); ok {
				if t, _ := b["type"].(string); t == "text" {
					if text, ok := b["text"].(string); ok {
						parts = append(parts, text)
					}
				}
			}
		}
		return strings.Join(parts, "\n")
	}
	return ""
}

func jsonString(m map[string]any, key string) string {
	if v, ok := m[key].(string); ok {
		return v
	}
	return ""
}

func jsonFloat(m map[string]any, key string, def float64) float64 {
	if v, ok := m[key].(float64); ok {
		return v
	}
	return def
}

func strPtr(s string) *string {
	return &s
}

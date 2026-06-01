package conversation

import (
	"bufio"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// MigrateResult holds the outcome of a format conversion.
type MigrateResult struct {
	NewSessionID string `json:"newSessionId"`
	OutputPath   string `json:"outputPath"`
	MessageCount int    `json:"messageCount"`
	ContentHash  string `json:"contentHash"`
}

// claudeCodeLine is the read-side struct for parsing Claude Code JSONL.
// It only captures the fields needed for content extraction.
type claudeCodeLine struct {
	Type      string        `json:"type"`
	UUID      string        `json:"uuid"`
	Timestamp string        `json:"timestamp"`
	Message   claudeCodeMsg `json:"message"`
}

type claudeCodeMsg struct {
	Role       string `json:"role"`
	Content    any    `json:"content"`
	Model      string `json:"model,omitempty"`
	StopReason string `json:"stop_reason,omitempty"`
}

// claudeCodeFullLine is the write-side struct with all fields needed for
// Claude CLI --resume to accept the conversation.
type claudeCodeFullLine struct {
	Type        string `json:"type"`
	UUID        string `json:"uuid"`
	ParentUUID  any    `json:"parentUuid"`      // string or null
	SessionID   string `json:"sessionId"`
	Timestamp   string `json:"timestamp"`
	IsSidechain bool   `json:"isSidechain"`
	UserType    string `json:"userType"`
	Cwd         string `json:"cwd"`
	Version     string `json:"version"`
	Message     any    `json:"message"`
}

// claudeCodeAssistantMsg wraps the assistant response in the envelope that
// Claude Code expects (mirrors the Anthropic API response shape).
type claudeCodeAssistantMsg struct {
	Role       string `json:"role"`
	Content    any    `json:"content"`
	Model      string `json:"model,omitempty"`
	StopReason string `json:"stop_reason,omitempty"`
	Type       string `json:"type,omitempty"` // "message"
}

// ValidationMsg holds a role+content pair for conversion validation.
type ValidationMsg struct {
	Role    string
	Content string
}

func generateUUID() string {
	b := make([]byte, 16)
	_, _ = rand.Read(b)
	b[6] = (b[6] & 0x0f) | 0x40 // version 4
	b[8] = (b[8] & 0x3f) | 0x80 // variant 10
	return fmt.Sprintf("%08x-%04x-%04x-%04x-%012x", b[0:4], b[4:6], b[6:8], b[8:10], b[10:])
}

// ionRoleToClaudeCode maps Ion roles to Claude Code roles.
// Both formats use "user" and "assistant" — no mapping needed for modern
// Claude Code, but older logs may use "human" which we still accept on read.
func ionRoleToClaudeCode(role string) string {
	return role
}

// claudeCodeRoleToIon maps Claude Code roles to Ion roles.
// Older Claude Code logs may use "human" instead of "user".
func claudeCodeRoleToIon(role string) string {
	if role == "human" {
		return "user"
	}
	return role
}

// ConvertIonToClaudeCode writes a loaded Ion Conversation as Claude Code JSONL.
// The output includes the full envelope (parentUuid chain, sessionId, cwd, etc.)
// that Claude CLI requires for --resume to work.
func ConvertIonToClaudeCode(conv *Conversation, newSessionID, outputDir string) (*MigrateResult, error) {
	if err := os.MkdirAll(outputDir, 0o755); err != nil {
		return nil, fmt.Errorf("create output dir: %w", err)
	}

	cwd := conv.WorkingDirectory
	if cwd == "" {
		cwd = "/"
	}

	path := getContextPathEntries(conv)

	var lines []string
	var prevUUID string
	count := 0
	for _, entry := range path {
		if entry.Type != EntryMessage {
			continue
		}
		md := asMessageData(entry.Data)
		if md == nil {
			continue
		}

		ccRole := ionRoleToClaudeCode(md.Role)
		ts := time.UnixMilli(entry.Timestamp).UTC().Format(time.RFC3339)
		uuid := generateUUID()

		// Build the message payload — assistant lines include extra envelope fields.
		var msgPayload any
		if ccRole == "assistant" {
			msgPayload = claudeCodeAssistantMsg{
				Role:       ccRole,
				Content:    md.Content,
				Model:      md.Model,
				StopReason: md.StopReason,
				Type:       "message",
			}
		} else {
			msgPayload = claudeCodeMsg{
				Role:    ccRole,
				Content: md.Content,
			}
		}

		var parentRef any = nil
		if prevUUID != "" {
			parentRef = prevUUID
		}

		line := claudeCodeFullLine{
			Type:        ccRole,
			UUID:        uuid,
			ParentUUID:  parentRef,
			SessionID:   newSessionID,
			Timestamp:   ts,
			IsSidechain: false,
			UserType:    "external",
			Cwd:         cwd,
			Version:     "2.1.0",
			Message:     msgPayload,
		}

		b, err := json.Marshal(line)
		if err != nil {
			return nil, fmt.Errorf("marshal line %d: %w", count, err)
		}
		lines = append(lines, string(b))
		prevUUID = uuid
		count++
	}

	outPath := filepath.Join(outputDir, newSessionID+".jsonl")
	if err := writeFileSynced(outPath, []byte(strings.Join(lines, "\n")+"\n")); err != nil {
		return nil, fmt.Errorf("write output: %w", err)
	}

	msgs := ExtractValidationMsgs(conv)
	return &MigrateResult{
		NewSessionID: newSessionID,
		OutputPath:   outPath,
		MessageCount: count,
		ContentHash:  contentHash(msgs),
	}, nil
}

// ConvertClaudeCodeToIon reads Claude Code JSONL and creates an Ion v2 Conversation.
func ConvertClaudeCodeToIon(inputPath, newSessionID, outputDir string) (*MigrateResult, error) {
	ccLines, err := LoadClaudeCodeMessages(inputPath)
	if err != nil {
		return nil, err
	}

	conv := CreateConversation(newSessionID, "", "")

	// Try to extract working directory and model from the source lines.
	cwd := extractCCField(inputPath, "cwd")
	if cwd != "" {
		conv.WorkingDirectory = cwd
	}

	for _, cl := range ccLines {
		role := claudeCodeRoleToIon(cl.Message.Role)
		md := MessageData{
			Role:    role,
			Content: cl.Message.Content,
		}
		// Extract model and stop_reason from assistant message envelopes.
		if role == "assistant" {
			md.Model, md.StopReason = extractCCAssistantMeta(cl)
		}
		AppendEntry(conv, EntryMessage, md)
	}

	// Rebuild the Messages slice from the entry tree.
	conv.Messages = BuildContextPath(conv)

	if err := Save(conv, outputDir); err != nil {
		return nil, fmt.Errorf("save ion conversation: %w", err)
	}

	msgs := ExtractValidationMsgs(conv)
	return &MigrateResult{
		NewSessionID: newSessionID,
		OutputPath:   filepath.Join(outputDir, newSessionID+".jsonl"),
		MessageCount: len(ccLines),
		ContentHash:  contentHash(msgs),
	}, nil
}

// LoadClaudeCodeMessages parses a Claude Code JSONL file into typed structs.
// Only lines with type "user", "human", or "assistant" are returned — other
// line types (queue-operation, attachment, last-prompt, etc.) are skipped.
func LoadClaudeCodeMessages(filePath string) ([]claudeCodeLine, error) {
	f, err := os.Open(filePath)
	if err != nil {
		return nil, fmt.Errorf("open claude code file: %w", err)
	}
	defer f.Close() //nolint:errcheck

	var result []claudeCodeLine
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)
	lineNum := 0

	for scanner.Scan() {
		lineNum++
		line := strings.TrimSpace(scanner.Text())
		if line == "" {
			continue
		}
		var cl claudeCodeLine
		if err := json.Unmarshal([]byte(line), &cl); err != nil {
			return nil, fmt.Errorf("line %d: invalid JSON: %w", lineNum, err)
		}
		// Only keep message-bearing lines (user/human/assistant).
		// Claude Code JSONL also contains queue-operation, attachment,
		// last-prompt, and other control lines that we skip.
		switch cl.Type {
		case "user", "human", "assistant":
			if cl.UUID == "" || cl.Timestamp == "" {
				return nil, fmt.Errorf("line %d: message line missing uuid or timestamp", lineNum)
			}
			result = append(result, cl)
		}
	}
	if err := scanner.Err(); err != nil {
		return nil, fmt.Errorf("read claude code file: %w", err)
	}
	return result, nil
}

// ValidateConversion re-reads the converted file and compares against source messages.
func ValidateConversion(sourceMsgs []ValidationMsg, convertedPath, format string) error {
	var convertedMsgs []ValidationMsg
	var err error

	switch format {
	case "claude_code":
		convertedMsgs, err = ExtractValidationMsgsFromClaudeCode(convertedPath)
	case "ion":
		// Derive the session ID and directory from the path.
		dir := filepath.Dir(convertedPath)
		base := filepath.Base(convertedPath)
		id := strings.TrimSuffix(strings.TrimSuffix(base, ".jsonl"), ".json")
		var conv *Conversation
		conv, err = Load(id, dir)
		if err == nil {
			convertedMsgs = ExtractValidationMsgs(conv)
		}
	default:
		return fmt.Errorf("unknown format: %s", format)
	}

	if err != nil {
		return fmt.Errorf("read converted file: %w", err)
	}

	if len(sourceMsgs) != len(convertedMsgs) {
		_ = os.Remove(convertedPath)
		return fmt.Errorf("message count mismatch: source=%d converted=%d", len(sourceMsgs), len(convertedMsgs))
	}

	srcHash := contentHash(sourceMsgs)
	convHash := contentHash(convertedMsgs)
	if srcHash != convHash {
		_ = os.Remove(convertedPath)
		return fmt.Errorf("content hash mismatch: source=%s converted=%s", srcHash, convHash)
	}
	return nil
}

// extractValidationMsgs builds validation messages from an Ion conversation's context path.
func ExtractValidationMsgs(conv *Conversation) []ValidationMsg {
	path := BuildContextPath(conv)
	msgs := make([]ValidationMsg, 0, len(path))
	for _, m := range path {
		msgs = append(msgs, ValidationMsg{
			Role:    m.Role,
			Content: extractText(m),
		})
	}
	return msgs
}

// extractValidationMsgsFromClaudeCode reads a Claude Code JSONL and extracts validation messages.
func ExtractValidationMsgsFromClaudeCode(path string) ([]ValidationMsg, error) {
	lines, err := LoadClaudeCodeMessages(path)
	if err != nil {
		return nil, err
	}
	msgs := make([]ValidationMsg, 0, len(lines))
	for _, cl := range lines {
		msgs = append(msgs, ValidationMsg{
			Role:    claudeCodeRoleToIon(cl.Message.Role),
			Content: flattenContent(cl.Message.Content),
		})
	}
	return msgs, nil
}

// contentHash computes a SHA-256 hex digest over concatenated "role:content\n" pairs.
func contentHash(msgs []ValidationMsg) string {
	h := sha256.New()
	for _, m := range msgs {
		_, _ = fmt.Fprintf(h, "%s:%s\n", m.Role, m.Content)
	}
	return hex.EncodeToString(h.Sum(nil))
}

// extractCCField reads the first occurrence of a string field from a Claude Code JSONL.
func extractCCField(filePath, field string) string {
	f, err := os.Open(filePath)
	if err != nil {
		return ""
	}
	defer f.Close() //nolint:errcheck

	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 0, 64*1024), maxScanTokenSize)
	for scanner.Scan() {
		var raw map[string]any
		if err := json.Unmarshal(scanner.Bytes(), &raw); err != nil {
			continue
		}
		if v, ok := raw[field].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

// extractCCAssistantMeta pulls model and stop_reason from a Claude Code assistant line.
func extractCCAssistantMeta(cl claudeCodeLine) (model, stopReason string) {
	return cl.Message.Model, cl.Message.StopReason
}

// flattenContent extracts plain text from various content representations.
func flattenContent(content any) string {
	switch c := content.(type) {
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
	case map[string]any:
		if t, _ := c["type"].(string); t == "text" {
			if text, ok := c["text"].(string); ok {
				return text
			}
		}
	}
	return ""
}

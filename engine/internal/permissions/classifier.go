// Package permissions provides an LLM-based command safety classifier.
package permissions

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/providers"
	"github.com/dsswift/ion/engine/internal/types"
)

// ClassifyResult is the output of an LLM classification.
type ClassifyResult struct {
	Decision   string  // "allow", "deny"
	Confidence float64
	Reason     string
}

// LlmClassifier uses a cheap LLM call to classify bash command safety.
type LlmClassifier struct {
	mu       sync.Mutex
	cache    map[string]cacheEntry
	maxCache int
	ttl      time.Duration
	model    string
}

type cacheEntry struct {
	result    ClassifyResult
	expiresAt time.Time
}

// NewLlmClassifier creates a classifier with LRU cache.
func NewLlmClassifier(model string) *LlmClassifier {
	if model == "" {
		model = "claude-haiku-4-5-20251001"
	}
	return &LlmClassifier{
		cache:    make(map[string]cacheEntry),
		maxCache: 256,
		ttl:      30 * time.Minute,
		model:    model,
	}
}

// Classify asks the LLM whether a bash command is safe.
func (c *LlmClassifier) Classify(ctx context.Context, command string) ClassifyResult {
	// Check cache first
	c.mu.Lock()
	if entry, ok := c.cache[command]; ok && time.Now().Before(entry.expiresAt) {
		c.mu.Unlock()
		return entry.result
	}
	c.mu.Unlock()

	// Call LLM
	result := c.callLlm(ctx, command)

	// Cache result
	c.mu.Lock()
	// Evict if at capacity
	if len(c.cache) >= c.maxCache {
		// Simple eviction: clear oldest quarter
		count := 0
		for k := range c.cache {
			delete(c.cache, k)
			count++
			if count >= c.maxCache/4 {
				break
			}
		}
	}
	c.cache[command] = cacheEntry{
		result:    result,
		expiresAt: time.Now().Add(c.ttl),
	}
	c.mu.Unlock()

	return result
}

// ClearCache empties the classification cache.
func (c *LlmClassifier) ClearCache() {
	c.mu.Lock()
	c.cache = make(map[string]cacheEntry)
	c.mu.Unlock()
}

func (c *LlmClassifier) callLlm(ctx context.Context, command string) ClassifyResult {
	provider := providers.ResolveProvider(c.model)
	if provider == nil {
		// Fallback: deny if can't classify
		return ClassifyResult{
			Decision:   "deny",
			Confidence: 0.5,
			Reason:     "classifier unavailable",
		}
	}

	systemPrompt := `You are a security classifier. Analyze the given bash command and respond with exactly one word: SAFE or UNSAFE.

SAFE: read-only commands, build commands, test commands, file viewing.
UNSAFE: commands that delete data, modify system config, send data externally, install backdoors, or could damage the system.

Respond ONLY with SAFE or UNSAFE, nothing else.`

	messages := []types.LlmMessage{
		{Role: "user", Content: fmt.Sprintf("Classify this bash command:\n%s", command)},
	}

	opts := types.LlmStreamOptions{
		Model:     c.model,
		System:    systemPrompt,
		Messages:  messages,
		MaxTokens: 10,
	}

	events, errc := provider.Stream(ctx, opts)

	var response strings.Builder
	for ev := range events {
		if ev.Delta != nil && ev.Delta.Text != "" {
			response.WriteString(ev.Delta.Text)
		}
	}
	if errc != nil {
		<-errc
	}

	text := strings.TrimSpace(strings.ToUpper(response.String()))

	if strings.Contains(text, "SAFE") && !strings.Contains(text, "UNSAFE") {
		return ClassifyResult{Decision: "allow", Confidence: 0.8, Reason: "LLM classified as safe"}
	}
	return ClassifyResult{Decision: "deny", Confidence: 0.8, Reason: "LLM classified as unsafe"}
}

// buildClassificationPrompt creates the prompt sent to the LLM for command
// safety classification (legacy format).
func buildClassificationPrompt(command string) string {
	return fmt.Sprintf(`Classify the following shell command as one of: safe, caution, dangerous.

Respond with exactly one line in this format:
SAFETY: <safe|caution|dangerous> REASON: <brief explanation>

Rules:
- "dangerous": Commands that can cause irreversible data loss, system damage, or security compromise (rm -rf /, chmod 777, curl|sh, etc.)
- "caution": Commands that modify files, install packages, or change system state in potentially risky ways
- "safe": Read-only commands, standard development operations

Command: %s`, command)
}

// parseClassificationResponse extracts safety level and reason from the LLM response.
func parseClassificationResponse(response string) (string, string) {
	// Default to caution if parsing fails
	safety := "caution"
	reason := "unable to parse classification"

	// Look for "SAFETY: <level> REASON: <reason>" pattern
	for _, line := range splitLines(response) {
		if len(line) < 8 {
			continue
		}
		// Find SAFETY: prefix
		idx := indexOf(line, "SAFETY:")
		if idx < 0 {
			continue
		}
		rest := line[idx+7:]
		rest = trimSpace(rest)

		// Find REASON: separator
		reasonIdx := indexOf(rest, "REASON:")
		if reasonIdx >= 0 {
			safety = trimSpace(rest[:reasonIdx])
			reason = trimSpace(rest[reasonIdx+7:])
		} else {
			safety = trimSpace(rest)
		}
		break
	}

	// Normalize safety level
	switch safety {
	case "safe", "caution", "dangerous":
		// valid
	default:
		safety = "caution"
	}

	return safety, reason
}

// Helper functions to avoid importing strings for simple ops.

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			lines = append(lines, s[start:i])
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}

func indexOf(s, sub string) int {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}

func trimSpace(s string) string {
	start := 0
	for start < len(s) && (s[start] == ' ' || s[start] == '\t') {
		start++
	}
	end := len(s)
	for end > start && (s[end-1] == ' ' || s[end-1] == '\t') {
		end--
	}
	return s[start:end]
}

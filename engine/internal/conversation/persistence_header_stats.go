package conversation

// persistence_header_stats.go — LlmHeaderStats, LoadLlmHeaderStats, and
// LoadLlmHeaderCost split from persistence.go to keep that file under the
// 800-line cap.
//
// These three declarations form a natural cohesion seam: they are the
// "lightweight header read" path for cost and token aggregation, distinct
// from the full conversation Load path.

import (
	"bufio"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// LlmHeaderStats holds the per-conversation token and cost totals read from
// a conversation's .llm.jsonl header in one pass.
type LlmHeaderStats struct {
	Model             string
	TotalInputTokens  int
	TotalOutputTokens int
	TotalCost         float64
}

// LoadLlmHeaderStats reads the model, totalInputTokens, totalOutputTokens,
// and totalCost fields from a conversation's .llm.jsonl header in a single
// file pass. This is more efficient than calling LoadLlmHeaderModel and
// LoadLlmHeaderCost separately when all three values are needed (e.g.
// during the per-model cost breakdown walk in cost.ConversationCostBreakdown).
//
// Returns zero-value LlmHeaderStats (with empty Model) when the header exists
// but lacks one or more fields — a fresh conversation has no persisted tokens
// or cost, which is not an error. An error is returned only for a missing file
// or a parse failure.
func LoadLlmHeaderStats(id, dir string) (LlmHeaderStats, error) {
	if dir == "" {
		dir = DefaultConversationsDir()
	}

	llmPath := filepath.Join(dir, id+".llm.jsonl")
	f, err := os.Open(llmPath)
	if err != nil {
		if os.IsNotExist(err) {
			return LlmHeaderStats{}, fmt.Errorf("%w: %s", ErrNotFound, id)
		}
		return LlmHeaderStats{}, fmt.Errorf("open llm file %s: %w", llmPath, err)
	}
	defer func() { _ = f.Close() }()

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
		return LlmHeaderStats{}, fmt.Errorf("scan llm header %s: %w", llmPath, err)
	}
	if headerLine == "" {
		return LlmHeaderStats{}, fmt.Errorf("empty llm file: %s", llmPath)
	}

	var header map[string]any
	if err := json.Unmarshal([]byte(headerLine), &header); err != nil {
		return LlmHeaderStats{}, fmt.Errorf("invalid llm header in %s: %w", llmPath, err)
	}

	stats := LlmHeaderStats{
		Model:             jsonString(header, "model"),
		TotalInputTokens:  int(jsonFloat(header, "totalInputTokens", 0)),
		TotalOutputTokens: int(jsonFloat(header, "totalOutputTokens", 0)),
		TotalCost:         jsonFloat(header, "totalCost", 0),
	}
	utils.LogWithFields(utils.LevelDebug, "conversation", "load llm header stats", map[string]any{
		"conversation_id": id, "model": stats.Model,
		"input_tokens": stats.TotalInputTokens, "output_tokens": stats.TotalOutputTokens,
		"cost_usd": stats.TotalCost,
	})
	return stats, nil
}

// LoadLlmHeaderCost reads only the totalCost field from a conversation's
// .llm.jsonl header without parsing any messages. This is a lightweight
// alternative to Load when only the session cost is needed (e.g. aggregate
// cost walk across a dispatch tree).
//
// Delegates to LoadLlmHeaderStats so there is one file-open path for the
// header; callers that need only the cost scalar pay for one read.
//
// Returns (0, nil) when the totalCost key is missing or zero — a fresh
// conversation has no persisted cost, which is not an error. An error is
// returned only for a missing file or a parse failure.
func LoadLlmHeaderCost(id, dir string) (float64, error) {
	stats, err := LoadLlmHeaderStats(id, dir)
	if err != nil {
		return 0, err
	}
	return stats.TotalCost, nil
}

package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/compaction"
	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// SessionMemory maintains a background summary of the conversation that
// can be used as a zero-cost compaction summary. It updates periodically
// after model responses (triggered by turn_end) when the conversation has
// grown significantly since the last update.
type SessionMemory struct {
	mu sync.RWMutex

	convID  string
	convDir string
	memory  string

	// Tracking for debounce decisions.
	lastUpdateTokens int
	lastUpdateTurn   int

	// Configuration.
	model           string
	maxTokens       int
	updateThreshold int // token growth before triggering update
	updateMinTurns  int // minimum turns between updates

	// Lifecycle.
	ctx    context.Context
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

// DefaultMemoryMaxTokens is the maximum output tokens for the memory file.
const DefaultMemoryMaxTokens = 8192

// DefaultMemoryUpdateThreshold is the token growth since the last update
// that triggers a new background summary.
const DefaultMemoryUpdateThreshold = 20000

// DefaultMemoryUpdateMinTurns is the minimum number of turns between
// background memory updates.
const DefaultMemoryUpdateMinTurns = 5

// NewSessionMemory creates a session memory manager. Call Start() to begin
// background updates, or load existing memory via LoadMemory().
func NewSessionMemory(convID, convDir string, opts *types.RunOptions) *SessionMemory {
	sm := &SessionMemory{
		convID:          convID,
		convDir:         convDir,
		model:           "",
		maxTokens:       DefaultMemoryMaxTokens,
		updateThreshold: DefaultMemoryUpdateThreshold,
		updateMinTurns:  DefaultMemoryUpdateMinTurns,
	}

	if opts != nil {
		if opts.CompactMemoryModel != "" {
			sm.model = opts.CompactMemoryModel
		}
		if opts.CompactMemoryMaxTokens > 0 {
			sm.maxTokens = opts.CompactMemoryMaxTokens
		}
		if opts.CompactMemoryUpdateThreshold > 0 {
			sm.updateThreshold = opts.CompactMemoryUpdateThreshold
		}
		if opts.CompactMemoryUpdateMinTurns > 0 {
			sm.updateMinTurns = opts.CompactMemoryUpdateMinTurns
		}
	}

	return sm
}

// memoryFilePath returns the path to the memory file for this conversation.
func (sm *SessionMemory) memoryFilePath() string {
	return filepath.Join(sm.convDir, sm.convID+".memory.md")
}

// LoadMemory loads an existing memory file from disk. Returns true if a
// memory file was found and loaded.
func (sm *SessionMemory) LoadMemory() bool {
	path := sm.memoryFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	sm.mu.Lock()
	sm.memory = string(data)
	sm.mu.Unlock()
	utils.Log("SessionMemory", fmt.Sprintf("loaded memory file: %s (%d bytes)", path, len(data)))
	return true
}

// GetMemory returns the current session memory content. Returns empty
// string if no memory has been generated yet.
func (sm *SessionMemory) GetMemory() string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.memory
}

// SetMemory replaces the current session memory with custom content.
// This is exposed to extensions via the SDK so they can provide their
// own summarization strategies.
func (sm *SessionMemory) SetMemory(content string) {
	sm.mu.Lock()
	sm.memory = content
	sm.mu.Unlock()

	// Persist to disk.
	sm.persistMemory(content)
}

// persistMemory writes the given content to the memory file on disk.
func (sm *SessionMemory) persistMemory(content string) {
	path := sm.memoryFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		utils.Warn("SessionMemory", "failed to create memory dir: "+err.Error())
		return
	}
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		utils.Warn("SessionMemory", "failed to write memory file: "+err.Error())
	}
}

// GetLastUpdateTurn returns the turn number of the last memory update.
func (sm *SessionMemory) GetLastUpdateTurn() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.lastUpdateTurn
}

// Start initializes background memory updates. The cancel function is
// stored so Stop() can terminate any in-flight summarization.
func (sm *SessionMemory) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	sm.ctx = ctx
	sm.cancel = cancel
	utils.Log("SessionMemory", fmt.Sprintf("started for conversation %s", sm.convID))
}

// Stop cancels any in-flight background summarization and waits for it
// to complete. Safe to call multiple times.
func (sm *SessionMemory) Stop() {
	if sm.cancel != nil {
		sm.cancel()
	}
	sm.wg.Wait()
	utils.Log("SessionMemory", fmt.Sprintf("stopped for conversation %s", sm.convID))
}

// OnTurnEnd is called after each model response. It checks whether an
// update is warranted based on token growth and turn count, and if so,
// spawns a background goroutine to generate and persist a new summary.
func (sm *SessionMemory) OnTurnEnd(conv *conversation.Conversation, turnNumber int) {
	sm.mu.RLock()
	lastTokens := sm.lastUpdateTokens
	lastTurn := sm.lastUpdateTurn
	sm.mu.RUnlock()

	// Check debounce: enough turns elapsed?
	if turnNumber-lastTurn < sm.updateMinTurns {
		utils.Debug("SessionMemory", fmt.Sprintf(
			"OnTurnEnd: skipping update, insufficient turns (turn=%d lastUpdate=%d minTurns=%d)",
			turnNumber, lastTurn, sm.updateMinTurns))
		return
	}

	// Check debounce: enough token growth?
	currentTokens := conversation.EstimateTokens(conv.Messages)
	if currentTokens-lastTokens < sm.updateThreshold {
		utils.Debug("SessionMemory", fmt.Sprintf(
			"OnTurnEnd: skipping update, insufficient token growth (tokens=%d lastUpdate=%d threshold=%d)",
			currentTokens, lastTokens, sm.updateThreshold))
		return
	}

	utils.Log("SessionMemory", fmt.Sprintf(
		"OnTurnEnd: triggering background summary (turn=%d tokens=%d growth=%d)",
		turnNumber, currentTokens, currentTokens-lastTokens))

	// Spawn background summarization. The goroutine captures the current
	// message state so the runloop is not blocked.
	messagesCopy := make([]types.LlmMessage, len(conv.Messages))
	copy(messagesCopy, conv.Messages)

	sm.wg.Add(1)
	go func() {
		defer sm.wg.Done()

		// Check cancellation before doing work.
		select {
		case <-sm.ctx.Done():
			return
		default:
		}

		text := compaction.FormatMessagesForSummary(messagesCopy)
		if text == "" {
			utils.Debug("SessionMemory", "OnTurnEnd: no text content in messages, skipping")
			return
		}

		// Prefix with instruction for a memory-style summary.
		prompt := fmt.Sprintf(
			"[Instructions: Generate a structured session memory summarizing the entire conversation so far. "+
				"This will be used to restore context after compaction. Be thorough but concise — max %d tokens.]\n\n%s",
			sm.maxTokens, text)

		summary, _ := compaction.Summarize(sm.ctx, prompt, sm.model, sm.maxTokens)
		if summary == "" {
			// LLM unavailable — fall back to regex-based fact extraction.
			utils.Debug("SessionMemory", "OnTurnEnd: LLM summary unavailable, falling back to fact extraction")
			facts := compaction.ExtractFacts(messagesCopy)
			if len(facts) > 0 {
				summary = compaction.FormatFactsSummary(facts)
			}
		}

		if summary == "" {
			utils.Debug("SessionMemory", "OnTurnEnd: no summary generated")
			return
		}

		sm.mu.Lock()
		sm.memory = summary
		sm.lastUpdateTokens = currentTokens
		sm.lastUpdateTurn = turnNumber
		sm.mu.Unlock()

		// Persist to disk.
		sm.persistMemory(summary)
		utils.Log("SessionMemory", fmt.Sprintf(
			"updated memory at turn %d (tokens=%d, summary=%d chars)",
			turnNumber, currentTokens, len(summary)))
	}()
}

// InjectMemoryIntoSystemPrompt appends the session memory as a dedicated
// section in the system prompt. Only injects if memory is non-empty.
func (sm *SessionMemory) InjectMemoryIntoSystemPrompt(opts *types.RunOptions) {
	memory := sm.GetMemory()
	if memory == "" {
		return
	}

	section := fmt.Sprintf(
		"\n\n## Session Memory (from previous context)\n\n"+
			"The following is a summary of earlier conversation that was compacted:\n\n%s",
		memory)

	if opts.AppendSystemPrompt != "" {
		opts.AppendSystemPrompt += section
	} else {
		opts.AppendSystemPrompt = strings.TrimPrefix(section, "\n\n")
	}
	utils.Log("SessionMemory", fmt.Sprintf(
		"injected %d chars of session memory into system prompt", len(memory)))
}

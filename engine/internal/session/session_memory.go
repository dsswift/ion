package session

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

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

	// lastSummarizedEntryID is the entry ID of the newest conversation
	// entry captured in the most recent session memory summary. Used by
	// the compaction system to determine whether the memory actually
	// covers the messages being dropped. Empty means no boundary is known.
	lastSummarizedEntryID string

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
const DefaultMemoryUpdateThreshold = 5000

// DefaultMemoryUpdateMinTurns is the minimum number of turns between
// background memory updates.
const DefaultMemoryUpdateMinTurns = 3

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

// LoadMemory loads an existing memory file from disk. If the file
// contains YAML front-matter (delimited by --- lines), the metadata
// is parsed to restore lastUpdateTokens, lastUpdateTurn, and
// lastSummarizedEntryID. Returns true if a memory file was found.
func (sm *SessionMemory) LoadMemory() bool {
	path := sm.memoryFilePath()
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}

	content := string(data)
	sm.mu.Lock()

	// Parse front-matter if present: lines between opening and closing "---".
	if strings.HasPrefix(content, "---\n") {
		if endIdx := strings.Index(content[4:], "\n---\n"); endIdx >= 0 {
			frontMatter := content[4 : 4+endIdx]
			content = content[4+endIdx+5:] // skip past closing "---\n"

			for _, line := range strings.Split(frontMatter, "\n") {
				parts := strings.SplitN(line, ": ", 2)
				if len(parts) != 2 {
					continue
				}
				key, val := parts[0], parts[1]
				switch key {
				case "lastUpdateTokens":
					if n, err := fmt.Sscanf(val, "%d", &sm.lastUpdateTokens); n != 1 || err != nil {
						utils.LogWithFields(utils.LevelWarn, "session.memory", "loadmemory: failed to parse", map[string]any{"val": val})
					}
				case "lastUpdateTurn":
					if n, err := fmt.Sscanf(val, "%d", &sm.lastUpdateTurn); n != 1 || err != nil {
						utils.LogWithFields(utils.LevelWarn, "session.memory", "loadmemory: failed to parse", map[string]any{"val": val})
					}
				case "lastSummarizedEntryID":
					sm.lastSummarizedEntryID = val
				}
			}
			utils.LogWithFields(utils.LevelInfo, "session.memory", "loaded front-matter", map[string]any{"last_update_tokens": sm.lastUpdateTokens, "last_update_turn": sm.lastUpdateTurn, "last_summarized_entry_i_d": sm.lastSummarizedEntryID})
		}
	}

	sm.memory = content
	sm.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session.memory", "loaded memory file: ( bytes, content bytes)", map[string]any{"path": path, "count": len(data), "count_2": len(content)})
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

// persistMemory writes the given content to the memory file on disk,
// prepending YAML front-matter with debounce state and coverage
// boundary so the metadata survives session restarts.
func (sm *SessionMemory) persistMemory(content string) {
	path := sm.memoryFilePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.memory", "failed to create memory dir", map[string]any{"error": err.Error()})
		return
	}

	sm.mu.RLock()
	frontMatter := fmt.Sprintf("---\nlastUpdateTokens: %d\nlastUpdateTurn: %d\nlastSummarizedEntryID: %s\nupdatedAt: %s\n---\n",
		sm.lastUpdateTokens,
		sm.lastUpdateTurn,
		sm.lastSummarizedEntryID,
		time.Now().UTC().Format(time.RFC3339))
	sm.mu.RUnlock()

	if err := os.WriteFile(path, []byte(frontMatter+content), 0o644); err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.memory", "failed to write memory file", map[string]any{"error": err.Error()})
	}
}

// GetLastUpdateTurn returns the turn number of the last memory update.
func (sm *SessionMemory) GetLastUpdateTurn() int {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.lastUpdateTurn
}

// GetLastSummarizedEntryID returns the entry ID boundary of the most
// recent session memory summary. Returns empty string if no boundary
// has been recorded (e.g. memory was loaded from a legacy file without
// front-matter metadata).
func (sm *SessionMemory) GetLastSummarizedEntryID() string {
	sm.mu.RLock()
	defer sm.mu.RUnlock()
	return sm.lastSummarizedEntryID
}

// ResetUpdateTracking resets the debounce baselines to the given token
// count and turn number. Called after compaction drops messages and
// reduces the token count, so the growth threshold restarts from the
// post-compaction baseline instead of the pre-compaction peak (which
// would be unreachable when tokens went backwards).
func (sm *SessionMemory) ResetUpdateTracking(currentTokens int, currentTurn int) {
	sm.mu.Lock()
	defer sm.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session.memory", "resetupdatetracking: lastupdatetokens → lastupdateturn", map[string]any{"last_update_tokens": sm.lastUpdateTokens, "current_tokens": currentTokens, "last_update_turn": sm.lastUpdateTurn, "current_turn": currentTurn})
	sm.lastUpdateTokens = currentTokens
	sm.lastUpdateTurn = currentTurn
}

// Start initializes background memory updates. The cancel function is
// stored so Stop() can terminate any in-flight summarization.
func (sm *SessionMemory) Start() {
	ctx, cancel := context.WithCancel(context.Background())
	sm.ctx = ctx
	sm.cancel = cancel
	utils.LogWithFields(utils.LevelDebug, "session.memory", "started for conversation", map[string]any{"run_id": sm.convID})
}

// Stop cancels any in-flight background summarization and waits for it
// to complete. Safe to call multiple times.
func (sm *SessionMemory) Stop() {
	if sm.cancel != nil {
		sm.cancel()
	}
	sm.wg.Wait()
	utils.LogWithFields(utils.LevelInfo, "session.memory", "stopped for conversation", map[string]any{"run_id": sm.convID})
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
		utils.LogWithFields(utils.LevelDebug, "session.memory", "onturnend: skipping update, insufficient turns ( )", map[string]any{"turn_number": turnNumber, "last_turn": lastTurn, "update_min_turns": sm.updateMinTurns})
		return
	}

	// Check debounce: enough token growth?
	currentTokens := conversation.EstimateTokens(conv.Messages)
	if currentTokens-lastTokens < sm.updateThreshold {
		utils.LogWithFields(utils.LevelDebug, "session.memory", "onturnend: skipping update, insufficient token growth ( )", map[string]any{"current_tokens": currentTokens, "last_tokens": lastTokens, "update_threshold": sm.updateThreshold})
		return
	}

	utils.LogWithFields(utils.LevelInfo, "session.memory", "onturnend: triggering background summary ( )", map[string]any{"turn_number": turnNumber, "current_tokens": currentTokens, "current_tokens_last_tokens": currentTokens-lastTokens})

	// Capture the entry boundary BEFORE spawning the goroutine. This is
	// the newest entry that the summary will cover. CurrentLeafID reads the
	// leaf under the conversation's tree lock, so this snapshot can never
	// observe a half-applied append from a parallel tool goroutine.
	boundaryEntryID := conversation.CurrentLeafID(conv)

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

		// Build a structured prompt that guides the LLM to extract substance,
		// not noise. The explicit exclusion rules prevent the model from echoing
		// system prompt fragments, agent task descriptions, or repeated
		// instructions that dominate tool_result blocks.
		prompt := fmt.Sprintf(`[Session Memory Instructions]

Extract a structured session memory from the conversation below. This memory will be injected into the system prompt after context window compaction to restore important context.

RULES:
- Focus on USER messages and ASSISTANT actions/decisions. Tool results provide context but are not the substance.
- Do NOT include text from system prompts, AGENTS.md/CLAUDE.md content, agent task descriptions, or repeated instructions. These are already injected automatically and do not need to be preserved in memory.
- Do NOT include boilerplate like "Do not run git push", "Start writing code immediately", or other instruction fragments.
- Be concise and information-dense. Each section has a budget — stay within it.

SECTIONS (skip any with no content):

## Current Task (max ~500 words)
What is actively being worked on. Specific file names, function names, exact state of progress.

## Key Decisions (max ~400 words)
Important choices made — technologies selected, approaches chosen, trade-offs accepted. Include the reasoning.

## Files Modified (max ~400 words)
Files created, modified, or deleted with paths and brief notes on what changed.

## Errors & Fixes (max ~300 words)
Problems encountered and how they were resolved. Include error messages that might recur.

## User Preferences & Instructions (max ~300 words)
Explicit user preferences, project conventions, or constraints mentioned that should inform future work. Only include things the user actually said, not system prompt content.

## Pending Work (max ~200 words)
Tasks explicitly requested but not yet completed.

Total budget: %d tokens maximum. Prioritize recency — recent decisions and changes matter more than early-conversation context.

---

CONVERSATION:
%s`, sm.maxTokens, text)

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
		sm.lastSummarizedEntryID = boundaryEntryID
		sm.mu.Unlock()

		// Persist to disk.
		sm.persistMemory(summary)
		utils.LogWithFields(utils.LevelInfo, "session.memory", "updated memory at turn (, chars, )", map[string]any{"turn_number": turnNumber, "current_tokens": currentTokens, "count": len(summary), "boundary_entry_i_d": boundaryEntryID})
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
	utils.LogWithFields(utils.LevelInfo, "session.memory", "injected session memory into system prompt", map[string]any{"count": len(memory)})
}

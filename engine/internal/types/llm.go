package types

// --- LLM Provider Types (from engine/src/providers/types.ts) ---

// LlmStreamOptions configures a streaming LLM call.
type LlmStreamOptions struct {
	Model       string           `json:"model"`
	System      string           `json:"system"`
	Messages    []LlmMessage     `json:"messages"`
	Tools       []LlmToolDef     `json:"tools,omitempty"`
	ServerTools []map[string]any `json:"serverTools,omitempty"` // opaque server-side tools (e.g. web_search_20250305)
	MaxTokens   int              `json:"maxTokens,omitempty"`
	Thinking    *ThinkingConfig  `json:"thinking,omitempty"`
}

// LlmMessage is a single message in the LLM conversation.
// Content is either a plain string or a slice of LlmContentBlock.
type LlmMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []LlmContentBlock
}

// LlmContentBlock is a union type for message content blocks.
//
// Most fields are scoped to a single block-type variant (e.g. ToolUseID +
// Content + IsError describe a "tool_result" block). The block is the wire
// shape for both provider-bound content and engine-internal markers.
//
// New variant: "compact_boundary"
//
// The block-type "compact_boundary" marks a compaction boundary inside the
// conversation history. It is the structural alternative to the legacy
// "[Previous conversation summary]: …" prose-prefix marker and exists so
// the engine can slice history at a typed seam (see
// conversation.MessagesAfterLastCompactBoundary). The Summary field carries
// the human-readable summary text the model should see; provider
// serialisers translate the block to a normal text block on the wire so
// that providers never see an unknown block type. The remaining fields
// (Trigger, MessagesBefore/After, ClearedBlocks, TokensBefore, FactCount,
// RecentFiles, MessagesSummarized) are structured metadata mirrored from
// CompactingEvent + the compaction extractor output. All are optional and
// emitted with omitempty so older consumers continue to round-trip the
// block without loss.
type LlmContentBlock struct {
	Type      string         `json:"type"`
	Text      string         `json:"text,omitempty"`
	ID        string         `json:"id,omitempty"`
	Name      string         `json:"name,omitempty"`
	Input     map[string]any `json:"input,omitempty"`
	ToolUseID string         `json:"tool_use_id,omitempty"`
	Content   string         `json:"content,omitempty"`
	IsError   *bool          `json:"is_error,omitempty"`
	Thinking  string         `json:"thinking,omitempty"`
	Source    *ImageSource   `json:"source,omitempty"`

	// --- compact_boundary fields ---
	// All optional; only meaningful when Type == "compact_boundary".

	// Trigger is the compaction strategy that produced this boundary.
	// One of "auto" (proactive token-limit driven), "reactive" (provider
	// prompt_too_long retry), or "manual" (user-initiated). Empty when
	// unknown.
	Trigger string `json:"trigger,omitempty"`
	// MessagesSummarized is the number of source messages folded into the
	// Summary field. Zero when not tracked.
	MessagesSummarized int `json:"messagesSummarized,omitempty"`
	// MessagesBefore is the conversation message count at the moment the
	// boundary fired (pre-compaction).
	MessagesBefore int `json:"messagesBefore,omitempty"`
	// MessagesAfter is the conversation message count after the boundary
	// (post-compaction, including the boundary message itself).
	MessagesAfter int `json:"messagesAfter,omitempty"`
	// ClearedBlocks is the number of tool-result / large-text blocks
	// cleared by step-1 micro-compaction. Zero when no clears happened.
	ClearedBlocks int `json:"clearedBlocks,omitempty"`
	// TokensBefore is the reported context-token count at the moment the
	// boundary fired. Zero when not available (reactive path does not
	// always know this).
	TokensBefore int `json:"tokensBefore,omitempty"`
	// Summary is the rendered human-readable summary body the model sees
	// in place of the compacted region. Empty when no facts were
	// extracted and no harness summarizer ran.
	Summary string `json:"summary,omitempty"`
	// FactCount is the number of distinct structured facts the engine
	// extracted from the compacted region (post-dedupe).
	FactCount int `json:"factCount,omitempty"`
	// RecentFiles is the set of file paths surfaced by ExtractRecentFiles
	// at the moment of compaction. Provided as structured data so
	// consumers (and the model) can re-attach them without re-parsing
	// the Summary prose.
	RecentFiles []string `json:"recentFiles,omitempty"`
}

// ImageSource carries base64-encoded image data for vision.
type ImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// ImageAttachment carries pre-encoded image bytes supplied alongside a user
// prompt. The engine does not parse any client-side marker syntax; clients
// that want the LLM to see images send them through this structured field.
// Path is optional and used only for logging / correlation; the engine never
// reads from disk based on it.
type ImageAttachment struct {
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	Path      string `json:"path,omitempty"`
}

// LlmToolDef defines a tool available to the LLM provider.
type LlmToolDef struct {
	Name        string         `json:"name"`
	Description string         `json:"description"`
	InputSchema map[string]any `json:"input_schema"`
}

// LlmUsage tracks token counts from the LLM provider.
type LlmUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
}

// --- LLM Stream Events (Anthropic-canonical SSE shape) ---

// LlmStreamEvent is a tagged union for streaming events from providers.
type LlmStreamEvent struct {
	Type string `json:"type"`

	// message_start
	MessageInfo *LlmStreamMessageInfo `json:"message,omitempty"`

	// content_block_start / content_block_stop
	BlockIndex   int                    `json:"index,omitempty"`
	ContentBlock *LlmStreamContentBlock `json:"content_block,omitempty"`

	// content_block_delta
	Delta *LlmStreamDelta `json:"delta,omitempty"`

	// message_delta usage
	DeltaUsage *LlmUsage `json:"usage,omitempty"`
}

// LlmStreamMessageInfo carries the message metadata from message_start.
type LlmStreamMessageInfo struct {
	ID    string   `json:"id"`
	Model string   `json:"model"`
	Usage LlmUsage `json:"usage"`
}

// LlmStreamContentBlock describes a content block start.
type LlmStreamContentBlock struct {
	Type      string `json:"type"`
	ID        string `json:"id,omitempty"`
	Name      string `json:"name,omitempty"`
	Text      string `json:"text,omitempty"`
	ToolUseID string `json:"tool_use_id,omitempty"` // for web_search_tool_result
	Content   any    `json:"content,omitempty"`     // for web_search_tool_result (search results array)
}

// LlmStreamDelta carries an incremental content update.
type LlmStreamDelta struct {
	Type        string  `json:"type"`
	Text        string  `json:"text,omitempty"`
	PartialJSON string  `json:"partial_json,omitempty"`
	Thinking    string  `json:"thinking,omitempty"`
	StopReason  *string `json:"stop_reason,omitempty"`
}

// --- Model Registry ---

// ModelInfo contains metadata about a supported model.
type ModelInfo struct {
	ProviderID       string  `json:"providerId"`
	ContextWindow    int     `json:"contextWindow"`
	CostPer1kInput   float64 `json:"costPer1kInput"`
	CostPer1kOutput  float64 `json:"costPer1kOutput"`
	SupportsCaching  bool    `json:"supportsCaching,omitempty"`
	SupportsThinking bool    `json:"supportsThinking,omitempty"`
	SupportsImages   bool    `json:"supportsImages,omitempty"`
	IsCustom         bool    `json:"-"` // not serialized; set by config loader, propagated to ModelEntry
}

// ModelEntry is the wire-format model information returned by list_models.
// Tracked by contract sync.
type ModelEntry struct {
	ID               string  `json:"id"`
	ProviderID       string  `json:"providerId"`
	ContextWindow    int     `json:"contextWindow"`
	CostPer1kInput   float64 `json:"costPer1kInput"`
	CostPer1kOutput  float64 `json:"costPer1kOutput"`
	SupportsCaching  bool    `json:"supportsCaching,omitempty"`
	SupportsThinking bool    `json:"supportsThinking,omitempty"`
	SupportsImages   bool    `json:"supportsImages,omitempty"`
	IsCustom         bool    `json:"isCustom,omitempty"`
}

// ProviderEntry is the wire-format provider information returned by list_models.
// Tracked by contract sync.
type ProviderEntry struct {
	ID         string `json:"id"`
	HasAuth    bool   `json:"hasAuth"`
	AuthSource string `json:"authSource,omitempty"`
	BaseURL    string `json:"baseURL,omitempty"`
	APIKeyRef  string `json:"apiKeyRef,omitempty"`
}

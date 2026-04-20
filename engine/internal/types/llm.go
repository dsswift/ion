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
}

// ImageSource carries base64-encoded image data for vision.
type ImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
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
}

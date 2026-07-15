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
	// Temperature is the sampling temperature for the request. Pointer so
	// "unset" (nil → provider default applies) is distinct from an explicit
	// 0.0 (fully deterministic). Providers that support a temperature
	// parameter map it into their request body; providers without one ignore
	// it. Threaded from ctx.llmCall (LLMCallOpts.Temperature) and available
	// to any other caller that builds stream options directly.
	Temperature *float64 `json:"temperature,omitempty"`
	// ResponseFormat requests a provider-enforced output format. The only
	// recognized value today is "json_object", which OpenAI-compatible
	// providers map to response_format={"type":"json_object"}. Providers
	// without a native request-level format switch (e.g. Anthropic) ignore
	// it — the field is advisory there. Empty means "no enforced format".
	ResponseFormat string `json:"responseFormat,omitempty"`
}

// LlmMessage is a single message in the LLM conversation.
// Content is either a plain string or a slice of LlmContentBlock.
type LlmMessage struct {
	Role    string `json:"role"`
	Content any    `json:"content"` // string or []LlmContentBlock
	// Usage carries the API-reported token counts from the response that produced
	// this message. Set only on assistant messages; nil on all other roles.
	// Tagged json:"-" so it is excluded from JSON serialization (providers, disk,
	// wire) — it is an in-memory annotation only, populated by AddAssistantMessage
	// and rehydrated from conv.Entries at load time.
	Usage *LlmUsage `json:"-"`
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

	// --- context_injection field ---
	// Only meaningful when Type == "context_injection".

	// ContextPaths is the set of absolute instruction-file paths carried by
	// a context_injection block (read-triggered nested AGENTS.md/ION.md
	// descent). It is the STRUCTURAL dedup key: the nested-context seeder
	// recovers "which files are already injected" by reading this field off
	// the typed block, never by substring-matching the rendered "# Context
	// from <path>" prose in arbitrary message text. Storing the paths as
	// structured data is what makes the dedup precise — a user message that
	// merely contains the marker prose carries no ContextPaths and therefore
	// cannot poison the seed. Provider serialisers translate the block to a
	// plain text block on the wire (mirroring compact_boundary), so the model
	// still sees the rendered context and providers never see this field.
	ContextPaths []string `json:"contextPaths,omitempty"`
}

// ImageSource carries base64-encoded image data for vision.
type ImageSource struct {
	Type      string `json:"type"`
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
}

// ImageAttachment carries pre-encoded attachment bytes (images or PDF
// documents, keyed by MediaType) supplied alongside a user prompt. The engine
// does not parse any client-side marker syntax; clients that want the LLM to
// see attachment content send the bytes through this structured field --
// essential for remote clients whose filesystem the engine cannot reach.
// Path is optional and used for logging / correlation and redundant-marker
// stripping; the engine never reads from disk based on it.
//
// Supported MediaType values:
//   - "image/*"         — any image/* MIME type (e.g. "image/jpeg", "image/png",
//     "image/gif", "image/webp"). The engine emits a native
//     image block for the provider.
//   - "application/pdf" — the engine emits a native document block (the provider's
//     first-class PDF support). This is the standard path for
//     remote clients that cannot expose a filesystem path to
//     the engine host (#853).
//
// Any other MediaType value is silently skipped by the backend; the
// corresponding marker (if any) remains in the prompt for the Read-tool
// fallback to handle.
type ImageAttachment struct {
	MediaType string `json:"media_type"`
	Data      string `json:"data"`
	Path      string `json:"path,omitempty"`
}

// LlmToolDef defines a tool available to the LLM provider.
type LlmToolDef struct {
	Name         string         `json:"name"`
	Description  string         `json:"description"`
	InputSchema  map[string]any `json:"input_schema"`
	PlanModeSafe bool           `json:"planModeSafe,omitempty"`
}

// LlmUsage tracks token counts from the LLM provider.
type LlmUsage struct {
	InputTokens              int `json:"input_tokens"`
	OutputTokens             int `json:"output_tokens"`
	CacheReadInputTokens     int `json:"cache_read_input_tokens,omitempty"`
	CacheCreationInputTokens int `json:"cache_creation_input_tokens,omitempty"`
}

// --- LLM Stream Events (Anthropic-canonical SSE shape) ---

// LlmStreamEventStreamReset is an in-band marker injected by the retry
// wrapper (providers.WithRetry) when a retryable failure interrupted a
// stream after events were already forwarded to the caller. On receipt the
// consumer must discard all state accumulated for the current attempt; the
// events that follow re-stream the turn from the start. This is an
// engine-internal marker, not a provider SSE event type.
const LlmStreamEventStreamReset = "stream_reset"

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
	// ImageData / ImageMediaType carry a provider-generated image (Type=="image").
	// ImageData is base64-encoded bytes; ImageMediaType is the MIME type
	// (e.g. "image/png"). The engine is a pass-through: it saves these bytes to
	// the conversation's images/ directory and emits an ImageContentEvent
	// carrying the on-disk FILE PATH — base64 never reaches the wire. Empty for
	// every non-image block (the overwhelming majority).
	ImageData      string `json:"image_data,omitempty"`
	ImageMediaType string `json:"image_media_type,omitempty"`
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
	ProviderID      string  `json:"providerId"`
	ContextWindow   int     `json:"contextWindow"`
	CostPer1kInput  float64 `json:"costPer1kInput"`
	CostPer1kOutput float64 `json:"costPer1kOutput"`
	// CostPer1kCacheCreation is the per-1k-token cost for prompt-cache creation
	// (writing new tokens into the cache). When zero the cost.TurnCost function
	// falls back to 1.25× CostPer1kInput, which matches Anthropic's published
	// cache-write multiplier for models that do not yet carry explicit pricing.
	CostPer1kCacheCreation float64 `json:"costPer1kCacheCreation,omitempty"`
	// CostPer1kCacheRead is the per-1k-token cost for reading from the prompt
	// cache. When zero the cost.TurnCost function falls back to 0.1× CostPer1kInput,
	// which matches Anthropic's published cache-read discount for models that
	// do not yet carry explicit pricing.
	CostPer1kCacheRead float64 `json:"costPer1kCacheRead,omitempty"`
	SupportsCaching    bool    `json:"supportsCaching,omitempty"`
	SupportsThinking   bool    `json:"supportsThinking,omitempty"`
	SupportsImages     bool    `json:"supportsImages,omitempty"`
	// MaxOutputTokens is the model's maximum output-token capacity per response.
	// It is the per-model source of truth the provider body-builders use to size
	// the outbound max_tokens directive when the caller sets no explicit override.
	// Zero means "not declared for this model": OpenAI/Google omit the field
	// entirely (the provider applies the model's own maximum), while
	// Anthropic/Bedrock — whose APIs require the field — fall back to a
	// conservative provider constant. Additive field — omitempty, never breaks
	// existing consumers.
	MaxOutputTokens int `json:"maxOutputTokens,omitempty"`
	// ThinkingMode is the reasoning mechanism this model uses on the wire:
	//   "adaptive"         — Anthropic adaptive thinking + effort (current models)
	//   "budget"           — Anthropic legacy type:"enabled" + budget_tokens (older)
	//   "reasoning_effort" — OpenAI / OpenAI-compatible reasoning_effort
	//   "gemini"           — Google Gemini thinkingConfig
	//   "none" / ""        — no reasoning support
	// The shared resolveThinking helper reads this to pick the body shape.
	ThinkingMode string `json:"thinkingMode,omitempty"`
	// ThinkingEfforts is the set of effort levels this model accepts, e.g.
	// ["low","medium","high"]. Clients use it to show/gray the per-conversation
	// thinking control honestly. Empty ⇒ thinking control hidden for this model.
	ThinkingEfforts []string `json:"thinkingEfforts,omitempty"`
	// Tokenizer is the tiktoken encoding name for this model's local BPE encoder.
	// One of "o200k_base" (GPT-4o/o-series/Claude), "cl100k_base" (legacy GPT-4/3.5
	// and approximate fallback for other families), or "" (no local encoder).
	// Additive field — omitempty, never breaks existing consumers.
	Tokenizer string `json:"tokenizer,omitempty"`
	IsCustom  bool   `json:"-"` // not serialized; set by config loader, propagated to ModelEntry
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
	// MaxOutputTokens is the model's maximum output-token capacity per response.
	// See ModelInfo.MaxOutputTokens for the value contract. Additive, omitempty.
	MaxOutputTokens int      `json:"maxOutputTokens,omitempty"`
	ThinkingMode    string   `json:"thinkingMode,omitempty"`
	ThinkingEfforts []string `json:"thinkingEfforts,omitempty"`
	// Tokenizer is the tiktoken encoding name for this model's local BPE encoder.
	// See ModelInfo.Tokenizer for the value contract. Additive, omitempty.
	Tokenizer string `json:"tokenizer,omitempty"`
	IsCustom  bool   `json:"isCustom,omitempty"`
}

// ProviderEntry is the wire-format provider information returned by list_models.
// Tracked by contract sync.
type ProviderEntry struct {
	ID         string `json:"id"`
	HasAuth    bool   `json:"hasAuth"`
	AuthSource string `json:"authSource,omitempty"`
	BaseURL    string `json:"baseURL,omitempty"`
	APIKeyRef  string `json:"apiKeyRef,omitempty"`
	// Backend is the credential-derived effective run backend for this
	// provider ("api" | "claude-code" | "codex" | "grok" | "cursor") — the
	// kind hybrid routing will actually pick for the next run (explicit
	// operator pref → api key wins → authed CLI → api). Additive, omitempty;
	// absent for providers with no CLI backend option.
	Backend string `json:"backend,omitempty"`
	// Cli carries the install/auth state of this provider's delegated CLI when
	// the provider has a CLI backend option (anthropic→claude-code,
	// openai→codex, xai→grok, cursor→cursor). Nil for API-only providers.
	// Additive, omitempty.
	Cli *ProviderCliStatus `json:"cli,omitempty"`
}

// ProviderCliStatus reports the install and authentication state of a
// provider's delegated CLI (the codex/claude/grok/cursor binaries). It is a
// probe snapshot the engine caches and refreshes; clients render it to guide
// install and sign-in. Additive wire type, tracked by contract sync.
type ProviderCliStatus struct {
	// Backend names the CLI backend this status describes.
	Backend string `json:"backend"`
	// Installed is true when the CLI binary was found on the host.
	Installed bool `json:"installed"`
	// BinaryPath is the resolved binary path when installed.
	BinaryPath string `json:"binaryPath,omitempty"`
	// Version is the CLI version string when detectable.
	Version string `json:"version,omitempty"`
	// Authenticated is true when the CLI reports a usable credential.
	Authenticated bool `json:"authenticated"`
	// AuthMethod is the CLI's active auth method (e.g. "chatgpt", "apiKey",
	// "cached_token").
	AuthMethod string `json:"authMethod,omitempty"`
	// PlanType is the subscription plan when known (e.g. "pro", "plus").
	PlanType string `json:"planType,omitempty"`
	// Email is the signed-in account email when known.
	Email string `json:"email,omitempty"`
	// Label is a human-friendly auth summary (e.g. "ChatGPT Pro").
	Label string `json:"label,omitempty"`
	// ProbedAt is the RFC3339 timestamp of this probe snapshot.
	ProbedAt string `json:"probedAt,omitempty"`
}

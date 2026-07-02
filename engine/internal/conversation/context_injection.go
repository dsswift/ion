package conversation

import (
	"github.com/dsswift/ion/engine/internal/types"
)

// ContextInjectionBlockType is the LlmContentBlock.Type discriminator used to
// mark a read-triggered nested-context injection inside conv.Messages. Exposed
// as a constant so call sites (the nested injector, the dedup seeder, provider
// serialisers, tests) cannot drift by typing the string literal.
const ContextInjectionBlockType = "context_injection"

// BuildContextInjectionMessage is the single construction site for nested
// context-injection messages (progressive AGENTS.md/ION.md descent). Every
// site that injects discovered subtree context into conv.Messages goes through
// here so the wire shape stays identical across origins.
//
// The returned message has Role: "user" — providers route user content without
// special-casing, and a typed system role would force every downstream consumer
// to learn a new shape. The structural marker lives on the content block, not
// the message envelope. This mirrors BuildCompactBoundaryMessage exactly.
//
// renderedText is the human-readable "# Context from <path>\n<body>" block the
// model sees. paths is the set of absolute instruction-file paths the block
// carries — the STRUCTURAL dedup key the seeder reads back via
// CollectInjectedContextPaths. The rendered prose is for the model; the paths
// field is for the engine. The two never have to agree textually, so a user
// message that merely contains the marker prose can never be mistaken for a
// real injection.
func BuildContextInjectionMessage(paths []string, renderedText string) types.LlmMessage {
	return types.LlmMessage{
		Role: "user",
		Content: []types.LlmContentBlock{{
			Type:         ContextInjectionBlockType,
			Text:         renderedText,
			ContextPaths: paths,
		}},
	}
}

// contextInjectionPaths returns the ContextPaths carried by a single
// context_injection block, or nil when the message is not a context_injection.
// Handles all three content shapes a message may carry: the typed
// []LlmContentBlock slice (live runloop construction), the []interface{} slice
// with map[string]any blocks (after JSON round-trip from disk), and the
// catch-all (returns nil).
//
// Like IsCompactBoundary, the check is intentionally minimal: only the first
// content block is inspected, because every in-tree producer emits the
// injection as a single-block message.
func contextInjectionPaths(msg types.LlmMessage) []string {
	switch c := msg.Content.(type) {
	case []types.LlmContentBlock:
		if len(c) == 0 || c[0].Type != ContextInjectionBlockType {
			return nil
		}
		return c[0].ContextPaths
	case []interface{}:
		if len(c) == 0 {
			return nil
		}
		m, ok := c[0].(map[string]interface{})
		if !ok {
			return nil
		}
		if t, _ := m["type"].(string); t != ContextInjectionBlockType {
			return nil
		}
		// After a JSON round-trip the []string lands as []interface{}.
		raw, ok := m["contextPaths"].([]interface{})
		if !ok {
			return nil
		}
		out := make([]string, 0, len(raw))
		for _, v := range raw {
			if s, ok := v.(string); ok && s != "" {
				out = append(out, s)
			}
		}
		return out
	}
	return nil
}

// CollectInjectedContextPaths returns the set of instruction-file paths already
// injected into a conversation by the nested-context loader, recovered from the
// typed context_injection blocks in conv.Messages.
//
// This is the precise dedup seed for prior-session nested injections: it reads
// the structured ContextPaths field off each typed block, so it cannot be
// fooled by a user or model message whose body coincidentally contains a
// "# Context from <path>" line. (The eager root/home walk writes into the
// system prompt, not conv.Messages, and is seeded separately by scanning that
// single string — a legitimate use of text recovery, since the system prompt
// has no arbitrary user content.)
//
// Returns an empty set for a nil conversation so callers need no guard.
func CollectInjectedContextPaths(conv *Conversation) map[string]bool {
	seen := make(map[string]bool)
	if conv == nil {
		return seen
	}
	for _, msg := range conv.Messages {
		for _, p := range contextInjectionPaths(msg) {
			if p != "" {
				seen[p] = true
			}
		}
	}
	return seen
}

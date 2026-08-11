// hook_payloads_tools.go — tool-related hook payloads and results.
//
// Split from hook_payloads.go for the file-size cap. Same mirroring rule: the
// engine's sdk_hook_types.go is the source of truth and the parity test pins
// these shapes to its contract manifest.
package ion

import "encoding/json"

// ToolCallInfo is the payload for tool_call, fired before any tool runs.
type ToolCallInfo struct {
	ToolName string         `json:"toolName"`
	ToolID   string         `json:"toolId"`
	Input    map[string]any `json:"input"`
}

// ToolCallResult vetoes a tool call. Reason is surfaced to the model in place
// of the tool's output, so it should read as an explanation the model can act
// on.
type ToolCallResult struct {
	Block  bool   `json:"block"`
	Reason string `json:"reason,omitempty"`
}

// ToolStartInfo is the payload for tool_start.
type ToolStartInfo struct {
	ToolName string `json:"toolName"`
	ToolID   string `json:"toolId"`
}

// PerToolCallResult is the result of a per-tool call hook (bash_tool_call,
// read_tool_call, and the rest). Beyond vetoing, these hooks can rewrite the
// tool's arguments before it runs.
type PerToolCallResult struct {
	// Block refuses the call.
	Block bool `json:"block"`
	// Reason explains the refusal to the model.
	Reason string `json:"reason,omitempty"`
	// Mutate replaces the named argument values. Keys absent from the map
	// keep their original values.
	Mutate map[string]any `json:"mutate,omitempty"`
}

// ToolInput is the payload for the per-tool call hooks. The engine sends the
// tool's raw argument object, whose shape depends on the tool, so this is a
// raw message the handler unmarshals into whatever it expects.
type ToolInput json.RawMessage

// UnmarshalJSON stores the raw argument object verbatim.
func (t *ToolInput) UnmarshalJSON(data []byte) error {
	*t = append((*t)[:0], data...)
	return nil
}

// MarshalJSON returns the stored argument object.
func (t ToolInput) MarshalJSON() ([]byte, error) {
	if len(t) == 0 {
		return []byte("null"), nil
	}
	return t, nil
}

// Into unmarshals the tool arguments into v.
func (t ToolInput) Into(v any) error {
	if len(t) == 0 {
		return nil
	}
	return json.Unmarshal(t, v)
}

// ToolResultInfo is the payload for tool_result and the per-tool result hooks.
// Shape varies by tool, so it is delivered raw.
type ToolResultInfo json.RawMessage

// UnmarshalJSON stores the raw result verbatim.
func (t *ToolResultInfo) UnmarshalJSON(data []byte) error {
	*t = append((*t)[:0], data...)
	return nil
}

// MarshalJSON returns the stored result.
func (t ToolResultInfo) MarshalJSON() ([]byte, error) {
	if len(t) == 0 {
		return []byte("null"), nil
	}
	return t, nil
}

// Into unmarshals the tool result into v.
func (t ToolResultInfo) Into(v any) error {
	if len(t) == 0 {
		return nil
	}
	return json.Unmarshal(t, v)
}

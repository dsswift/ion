package backend

import (
	"encoding/json"
	"fmt"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// toolCallName is the API backend's engine tool that calls a deferred tool.
// A deferred tool never enters the tool list: the model finds its definition
// with ToolSearch and calls it through ToolCall. The list therefore never
// changes during a conversation, and the provider's cached prefix holds
// (ADR-038).
const toolCallName = "ToolCall"

// toolSearchDefaultResults is how many matches ToolSearch returns when the
// call names no limit.
const toolSearchDefaultResults = 5

// applyToolSearch decides which deferrable tools the run leaves out of its
// tool list, records them on the run, and adds ToolSearch and ToolCall when it
// left any out. The decision depends on the configured mode, the tool set, and
// the model's context window, never on the run's mode, so the list is the same
// whether the run is planning or not.
//
// Modes (types.ToolSearchConfig): off loads everything; on defers every
// deferrable tool; auto[:N] defers them once their definitions reach N percent
// of the context window. No configured mode is auto at the default threshold.
func applyToolSearch(run *activeRun, defs []types.LlmToolDef, rawMode, model string) []types.LlmToolDef {
	kept, deferred := splitForToolSearch(defs, rawMode, model, run.requestID)
	run.deferredTools = deferred
	return kept
}

// ToolListAfterToolSearch is the tool list an API run sends for defs under
// the configured mode: what a context breakdown taken outside a run counts.
func ToolListAfterToolSearch(defs []types.LlmToolDef, rawMode, model string) []types.LlmToolDef {
	kept, _ := splitForToolSearch(defs, rawMode, model, "")
	return kept
}

// splitForToolSearch returns the tool list to send and the deferred tools by
// name (nil when nothing is deferred).
func splitForToolSearch(defs []types.LlmToolDef, rawMode, model, requestID string) ([]types.LlmToolDef, map[string]types.LlmToolDef) {
	mode, err := types.ParseToolSearchMode(rawMode)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "backend.tool_search", "tool search mode invalid; using auto", map[string]any{
			"run_id": requestID, "mode": rawMode, "error": err.Error(),
		})
		mode = types.ToolSearchMode{Kind: types.ToolSearchAuto, Percent: types.DefaultToolSearchPercent}
	}
	if mode.Kind == types.ToolSearchDefault {
		mode = types.ToolSearchMode{Kind: types.ToolSearchAuto, Percent: types.DefaultToolSearchPercent}
	}

	var deferrable []types.LlmToolDef
	for _, d := range defs {
		if d.Deferrable {
			deferrable = append(deferrable, d)
		}
	}
	tokens := estimateToolTokens(deferrable)
	decide := func(deferred map[string]types.LlmToolDef, reason string) {
		utils.LogWithFields(utils.LevelInfo, "backend.tool_search", "tool search decided", map[string]any{
			"run_id": requestID, "mode": mode.String(), "deferrable": len(deferrable),
			"deferrable_tokens": tokens, "deferred": len(deferred), "reason": reason,
		})
	}
	if len(deferrable) == 0 {
		decide(nil, "no deferrable tools")
		return defs, nil
	}
	switch mode.Kind {
	case types.ToolSearchOff:
		decide(nil, "mode off")
		return defs, nil
	case types.ToolSearchAuto:
		if window := resolveContextWindow(model); tokens*100 < window*mode.Percent {
			decide(nil, "under the auto threshold")
			return defs, nil
		}
	}

	deferred := make(map[string]types.LlmToolDef, len(deferrable))
	kept := make([]types.LlmToolDef, 0, len(defs)-len(deferrable)+2)
	for _, d := range defs {
		if d.Deferrable {
			deferred[d.Name] = d
			continue
		}
		kept = append(kept, d)
	}
	decide(deferred, "deferred")
	return append(kept, toolSearchDef(deferred), toolCallDef()), deferred
}

// estimateToolTokens approximates the tokens tool definitions take, at four
// characters a token of their serialized form.
func estimateToolTokens(defs []types.LlmToolDef) int {
	total := 0
	for _, d := range defs {
		raw, err := json.Marshal(struct {
			Name        string         `json:"name"`
			Description string         `json:"description"`
			InputSchema map[string]any `json:"input_schema"`
		}{d.Name, d.Description, d.InputSchema})
		if err != nil {
			continue // an unencodable schema is counted as nothing; the provider rejects it anyway
		}
		total += len(raw) / 4
	}
	return total
}

// toolSearchDef is ToolSearch for this run: its description names every
// deferred tool, sorted, so the same tool set always yields the same bytes.
func toolSearchDef(deferred map[string]types.LlmToolDef) types.LlmToolDef {
	names := make([]string, 0, len(deferred))
	for name := range deferred {
		names = append(names, name)
	}
	sort.Strings(names)
	return types.LlmToolDef{
		Name: toolSearchName,
		Description: "Finds deferred tools and returns their definitions. These tools are available but not loaded: " +
			strings.Join(names, ", ") + ". " +
			"Pass keywords to search names and descriptions, or \"select:Name1,Name2\" to load tools by exact name. " +
			"Each result has the tool's name, description, and input schema. Call a returned tool with " + toolCallName + ".",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"query":       map[string]any{"type": "string", "description": "Keywords, or select:Name1,Name2"},
				"max_results": map[string]any{"type": "integer", "minimum": 1, "maximum": 50, "description": "Matches to return. Default 5."},
			},
			"required": []string{"query"},
		},
		PlanModeSafe: true,
	}
}

func toolCallDef() types.LlmToolDef {
	return types.LlmToolDef{
		Name:        toolCallName,
		Description: "Calls a deferred tool found with " + toolSearchName + ". `name` is the tool's exact name; `input` is its arguments, matching the input schema " + toolSearchName + " returned.",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{
				"name":  map[string]any{"type": "string"},
				"input": map[string]any{"type": "object"},
			},
			"required": []string{"name"},
		},
	}
}

// searchDeferredTools answers a ToolSearch call from the run's deferred tools.
func searchDeferredTools(deferred map[string]types.LlmToolDef, input map[string]any) *types.ToolResult {
	query, _ := input["query"].(string) //nolint:errcheck // a missing query matches nothing and says so
	limit := toolSearchDefaultResults
	if n, ok := input["max_results"].(float64); ok && n >= 1 {
		limit = min(int(n), 50)
	}
	var matches []types.LlmToolDef
	if names, ok := strings.CutPrefix(strings.TrimSpace(query), "select:"); ok {
		for _, name := range strings.Split(names, ",") {
			if d, found := deferred[strings.TrimSpace(name)]; found {
				matches = append(matches, d)
			}
		}
	} else {
		matches = rankDeferredTools(deferred, query, limit)
	}
	if len(matches) == 0 {
		return &types.ToolResult{Content: fmt.Sprintf("No deferred tool matches %q. The deferred tools are listed in the %s description.", query, toolSearchName)}
	}
	type found struct {
		Name        string         `json:"name"`
		Description string         `json:"description"`
		InputSchema map[string]any `json:"input_schema"`
	}
	out := make([]found, 0, len(matches))
	for _, d := range matches {
		out = append(out, found{d.Name, d.Description, d.InputSchema})
	}
	raw, err := json.Marshal(map[string]any{"tools": out, "call_with": toolCallName})
	if err != nil {
		return &types.ToolResult{Content: "Error: " + err.Error(), IsError: true}
	}
	return &types.ToolResult{Content: string(raw)}
}

// rankDeferredTools scores each deferred tool by how many query words its name
// (weighted) and description contain, best first, ties by name.
func rankDeferredTools(deferred map[string]types.LlmToolDef, query string, limit int) []types.LlmToolDef {
	words := strings.Fields(strings.ToLower(query))
	type scored struct {
		def   types.LlmToolDef
		score int
	}
	var hits []scored
	for _, d := range deferred {
		name := strings.ToLower(d.Name)
		desc := strings.ToLower(d.Description)
		score := 0
		for _, w := range words {
			if strings.Contains(name, w) {
				score += 3
			}
			if strings.Contains(desc, w) {
				score++
			}
		}
		if score > 0 {
			hits = append(hits, scored{d, score})
		}
	}
	sort.Slice(hits, func(i, j int) bool {
		if hits[i].score != hits[j].score {
			return hits[i].score > hits[j].score
		}
		return hits[i].def.Name < hits[j].def.Name
	})
	out := make([]types.LlmToolDef, 0, min(limit, len(hits)))
	for i := 0; i < len(hits) && i < limit; i++ {
		out = append(out, hits[i].def)
	}
	return out
}

// resolveToolCall turns a ToolCall into the deferred tool it names before
// anything else looks at the call. It reports true when the call was refused
// and its result already recorded; a run with nothing deferred is untouched.
func (b *ApiBackend) resolveToolCall(run *activeRun, block *types.LlmContentBlock, results []conversation.ToolResultEntry, i int) bool {
	if block.Name != toolCallName || run.deferredTools == nil {
		return false
	}
	return b.unwrapToolCall(run, block, results, i)
}

// searchDeferred answers a ToolSearch call from the run's deferred tools. It
// reports false for any other call, or when nothing is deferred.
func (run *activeRun) searchDeferred(block types.LlmContentBlock) (*types.ToolResult, bool) {
	if block.Name != toolSearchName || run.deferredTools == nil {
		return nil, false
	}
	return searchDeferredTools(run.deferredTools, block.Input), true
}

// unwrapToolCall turns a ToolCall into the deferred tool it names, so the plan
// policy, permissions, hooks, telemetry, and execution all see the real tool.
// A call naming no deferred tool is answered with an error result, the
// result is emitted, and it returns true.
func (b *ApiBackend) unwrapToolCall(run *activeRun, block *types.LlmContentBlock, results []conversation.ToolResultEntry, i int) bool {
	name, _ := block.Input["name"].(string) //nolint:errcheck // a missing name is refused below
	if _, ok := run.deferredTools[name]; !ok {
		utils.LogWithFields(utils.LevelInfo, "backend.tool_search", "tool call names no deferred tool", map[string]any{
			"run_id": run.requestID, "tool_use_id": block.ID, "name": name,
		})
		results[i] = conversation.ToolResultEntry{
			ToolUseID: block.ID,
			Content:   fmt.Sprintf("%q is not a deferred tool. Find the tool with %s, then call it by its exact name.", name, toolSearchName),
			IsError:   true,
		}
		if run.cfg != nil {
			emitToolFailure(run.cfg.Telemetry, run, toolFailureBlock{Name: toolCallName, ID: block.ID}, "unknown_tool", results[i].Content)
		}
		b.emit(run, types.NormalizedEvent{Data: &types.ToolResultEvent{ToolID: block.ID, Content: results[i].Content, IsError: true}})
		return true
	}
	input, _ := block.Input["input"].(map[string]any) //nolint:errcheck // a tool with no arguments takes an empty object
	if input == nil {
		input = map[string]any{}
	}
	utils.LogWithFields(utils.LevelInfo, "backend.tool_search", "tool call unwrapped to deferred tool", map[string]any{
		"run_id": run.requestID, "tool_use_id": block.ID, "name": name,
	})
	block.Name = name
	block.Input = input
	return false
}

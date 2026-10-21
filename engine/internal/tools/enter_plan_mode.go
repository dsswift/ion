// Package tools — EnterPlanMode sentinel tool.
//
// The engine ships only the sentinel mechanism: the tool name, an
// engine-neutral one-line default description, and an Execute hook that
// is never actually invoked (the runloop intercepts EnterPlanMode tool
// calls before they reach the execute path; see runloop_tools.go).
//
// The policy prose that tells the model WHEN to enter plan mode and
// WHAT the rules are once enabled lives in the harness. Per ADR-004,
// every harness ships its own description text and forwards it via the
// per-run RunOptions.EnterPlanModeDescription field; the engine forwards
// the harness string verbatim as the tool description if non-empty,
// falling back to the one-liner here when the harness has no opinion.
//
// A client or harness ships its own prose for this description; no one
// implementation has special status — any
// harness supplies its own (TUIs may prefer minimal framing;
// domain-specific harnesses may want JSON plans, "design doc" language,
// etc.).
//
// This file is the structural sibling of ExitPlanMode (exit_plan_mode.go),
// which also ships a one-line neutral description for the same reason.

package tools

import (
	"context"

	"github.com/dsswift/ion/engine/internal/types"
)

// EnterPlanModeName is the tool name used to identify the enter-plan-mode sentinel.
const EnterPlanModeName = "EnterPlanMode"

// enterPlanModeDefaultDescription is the engine's policy-neutral fallback
// description for the EnterPlanMode sentinel. Harnesses that want more
// detailed framing supply their own text via
// RunOptions.EnterPlanModeDescription (ADR-004). Keep this short and
// purely structural — no advice about WHEN to enter plan mode, no rules
// about what is allowed inside plan mode. Anything beyond "this is the
// tool that switches the session into plan mode" is harness policy.
const enterPlanModeDefaultDescription = "Switch the current session into plan mode."

// EnterPlanModeTool returns the sentinel tool with the engine's default
// one-line description. Equivalent to EnterPlanModeToolWithDescription("").
// Kept as a no-arg constructor so call sites that genuinely want the
// engine default (and tests pinning the default behavior) read clearly.
func EnterPlanModeTool() *types.ToolDef {
	return EnterPlanModeToolWithDescription("")
}

// EnterPlanModeToolWithDescription returns the sentinel tool with the
// supplied description. An empty `desc` falls back to the engine's
// one-line default (enterPlanModeDefaultDescription).
//
// The runloop calls this with opts.EnterPlanModeDescription on every
// auto-mode run that needs the sentinel injected (see runloop_setup.go).
// When the harness has set the field, the model sees the harness's
// prose verbatim; when it hasn't, the model sees the one-liner. The
// engine never composes a "default + harness override" — the harness
// either owns the description entirely or leaves it to the engine
// default. This keeps the policy/mechanism split clean: there is no
// engine prose for the harness to partially override.
//
// This tool is NOT registered in the global registry (same as
// ExitPlanMode) because it must only be available when explicitly
// injected for a specific run.
func EnterPlanModeToolWithDescription(desc string) *types.ToolDef {
	description := desc
	if description == "" {
		description = enterPlanModeDefaultDescription
	}
	return &types.ToolDef{
		Name:        EnterPlanModeName,
		Description: description,
		InputSchema: map[string]any{
			"type":       "object",
			"properties": map[string]any{},
			"required":   []string{},
		},
		Execute: func(ctx context.Context, input map[string]any, cwd string) (*types.ToolResult, error) {
			// This should never be called directly — the runloop intercepts
			// EnterPlanMode before executeTools reaches this point.
			return &types.ToolResult{
				Content: "Plan mode entry intercepted.",
				IsError: false,
			}, nil
		},
	}
}

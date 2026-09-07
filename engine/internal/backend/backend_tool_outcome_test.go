package backend

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/acp"
	"github.com/dsswift/ion/engine/internal/codexrpc"
	"github.com/dsswift/ion/engine/internal/telemetry"
	"github.com/dsswift/ion/engine/internal/types"
)

// This file verifies section 5 of child 06's spec: that
// telemetry.ToolResultOutcome derives a sensible outcome from each delegated
// backend's ACTUAL ToolResultEvent construction path -- not a synthetic
// ApiBackend-shaped fixture reused across backends. No production code
// changed for this section; these tests pin what was found.
//
// Finding: the "Permission denied: "/"Blocked: "/"Sandbox blocked: " Content
// prefixes ToolResultOutcome recognizes (see conversation_emitter.go) are an
// ApiBackend-only convention, minted exclusively in runloop_tools.go,
// runloop_tool_gate.go, and runloop_workspaces.go. Neither codex's
// item/completed translation (codex_events.go) nor ACP's tool_call_update
// translation (acp_events.go) ever construct a ToolResultEvent.Content with
// those prefixes -- codex carries the subprocess's own aggregatedOutput text,
// and ACP's translateAcpUpdate does not set Content at all. So
// OutcomeDenied/OutcomeBlocked are structurally unreachable from either
// backend's own translation path; only OutcomeSuccess/OutcomeError occur.
// Permission denial in both backends is negotiated over the delegated CLI's
// own protocol (codex's approval RPCs, ACP's onPermission) before a
// ToolResultEvent is ever produced, not encoded into ToolResultEvent.Content
// afterward.

// TestToolResultOutcome_CodexRealCompletedItem exercises the real codex
// item/completed -> ToolResultEvent translation (translateCodexNotification),
// then derives the outcome from what that path actually produces.
func TestToolResultOutcome_CodexRealCompletedItem(t *testing.T) {
	cases := []struct {
		name     string
		exitCode *int
		output   string
		want     string
	}{
		{"success", intPtr(0), "ok", telemetry.OutcomeSuccess},
		{"nonzero exit", intPtr(1), "command failed: permission denied", telemetry.OutcomeError},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			item := codexrpc.ItemNotification{
				Item: codexrpc.ThreadItem{
					Type:             "commandExecution",
					ID:               "item-1",
					AggregatedOutput: c.output,
					ExitCode:         c.exitCode,
				},
			}
			raw, err := json.Marshal(item)
			if err != nil {
				t.Fatalf("marshal: %v", err)
			}
			run := &codexRun{requestID: "req-codex-tool"}
			events, exit := translateCodexNotification(run, codexrpc.NotifItemCompleted, raw)
			if exit != nil {
				t.Fatal("item/completed for a tool must not end the run")
			}
			if len(events) != 1 {
				t.Fatalf("expected exactly 1 event, got %d", len(events))
			}
			tr, ok := events[0].Data.(*types.ToolResultEvent)
			if !ok {
				t.Fatalf("expected *types.ToolResultEvent, got %T", events[0].Data)
			}
			got := telemetry.ToolResultOutcome(tr.IsError, tr.Content)
			if got != c.want {
				t.Errorf("ToolResultOutcome(IsError=%v, Content=%q) = %q, want %q", tr.IsError, tr.Content, got, c.want)
			}
		})
	}
}

// TestToolResultOutcome_AcpRealToolCallUpdate exercises the real ACP
// tool_call_update -> ToolResultEvent translation (translateAcpUpdate).
func TestToolResultOutcome_AcpRealToolCallUpdate(t *testing.T) {
	cases := []struct {
		name   string
		status string
		want   string
	}{
		{"completed", "completed", telemetry.OutcomeSuccess},
		{"failed", "failed", telemetry.OutcomeError},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			run := &acpRun{requestID: "req-acp-tool"}
			update := acp.SessionUpdate{
				SessionUpdate: acp.UpdateToolCallUpdate,
				ToolCallID:    "tool-1",
				Status:        c.status,
			}
			events := translateAcpUpdate(run, update)
			if len(events) != 1 {
				t.Fatalf("expected exactly 1 event, got %d", len(events))
			}
			tr, ok := events[0].Data.(*types.ToolResultEvent)
			if !ok {
				t.Fatalf("expected *types.ToolResultEvent, got %T", events[0].Data)
			}
			got := telemetry.ToolResultOutcome(tr.IsError, tr.Content)
			if got != c.want {
				t.Errorf("ToolResultOutcome(IsError=%v, Content=%q) = %q, want %q", tr.IsError, tr.Content, got, c.want)
			}
			// ACP never populates Content for a tool_call_update -- confirm the
			// path this test exercises actually has that shape, so the "always
			// success/error, never denied/blocked" finding above is not
			// accidentally invalidated by a future change to this test alone.
			if tr.Content != "" {
				t.Errorf("expected ACP ToolResultEvent.Content to be empty (no prefix convention), got %q", tr.Content)
			}
		})
	}
}

// TestToolResultOutcome_AcpPendingUpdate confirms an in-flight ACP status
// (neither completed nor failed) produces no ToolResultEvent at all -- the
// terminal-result-only invariant conversation.tool_call relies on.
func TestToolResultOutcome_AcpPendingUpdate(t *testing.T) {
	run := &acpRun{requestID: "req-acp-pending"}
	update := acp.SessionUpdate{
		SessionUpdate: acp.UpdateToolCallUpdate,
		ToolCallID:    "tool-1",
		Status:        "in_progress",
	}
	events := translateAcpUpdate(run, update)
	if len(events) != 0 {
		t.Errorf("expected no events for a non-terminal ACP tool status, got %d", len(events))
	}
}

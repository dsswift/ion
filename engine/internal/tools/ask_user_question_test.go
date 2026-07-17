package tools

import (
	"strings"
	"testing"
)

// ask_user_question_test.go — pins the channel-correctness mechanics of the
// AskUserQuestion tool definition.
//
// The engine ships a deliberately opinionless description (see
// docs/architecture/adr/017-opinionless-tool-instructions.md): it states only
// what is required for the tool to work correctly — the question field carries
// the bare decision point, and any context the user needs must be VISIBLE
// assistant text before the call (private reasoning never reaches the user).
// It must NOT mandate styling (tradeoffs, recommendations, narrative shape) —
// that is consumer opinion, overridable via harness prose / operator config.

func TestAskUserQuestionDescription_ChannelMechanics(t *testing.T) {
	def := AskUserQuestionTool()

	// The visible-text channel rule: context must be visible assistant text
	// before the call, and private reasoning does not reach the user.
	for _, phrase := range []string{
		"visible assistant text",
		"BEFORE calling this tool",
		"never shown to them",
		"1-2 sentences",
	} {
		if !strings.Contains(def.Description, phrase) {
			t.Errorf("Description missing channel-mechanic phrase %q", phrase)
		}
	}

	// The question schema mirrors the same channel rule.
	props, _ := def.InputSchema["properties"].(map[string]any)
	q, _ := props["question"].(map[string]any)
	qDesc, _ := q["description"].(string)
	if !strings.Contains(qDesc, "visible assistant text") {
		t.Errorf("question schema description missing visible-text channel rule; got %q", qDesc)
	}
	if !strings.Contains(qDesc, "private reasoning is not shown to the user") {
		t.Errorf("question schema description missing private-reasoning clarification; got %q", qDesc)
	}
}

// TestAskUserQuestionDescription_StaysOpinionless guards ADR-017: the
// engine-shipped default must not mandate styling. If a future edit adds
// "tradeoffs", "recommendation", or similar workflow-shaping language to the
// engine default, this test goes red — that content belongs in harness prose
// or operator config, not here.
func TestAskUserQuestionDescription_StaysOpinionless(t *testing.T) {
	def := AskUserQuestionTool()
	lower := strings.ToLower(def.Description)
	for _, opinion := range []string{"tradeoff", "trade-off", "recommendation", "recommend"} {
		if strings.Contains(lower, opinion) {
			t.Errorf("Description contains opinionated styling term %q — engine tool instructions carry mechanics only (ADR-017)", opinion)
		}
	}
}

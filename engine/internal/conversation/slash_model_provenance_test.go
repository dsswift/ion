package conversation

import (
	"testing"
)

// TestSlashModelProvenanceRoundTrip pins the persistence contract: model
// provenance fields written via AddUserMessageWithInvocation must survive
// through flattenEntries and land on the SessionMessage.
func TestSlashModelProvenanceRoundTrip(t *testing.T) {
	conv := CreateConversation("slash-model-prov-test", "sys", "model")

	inv := SlashInvocation{
		Command:        "/deploy",
		Args:           "--prod",
		Source:         "project",
		ModelAlias:     "claude-sonnet",
		ModelEffective: "claude-sonnet-4-20250514",
	}

	AddUserMessageWithInvocation(conv, "/deploy --prod", inv)

	msgs := flattenEntries(conv)

	var found bool
	for _, m := range msgs {
		if m.Role == "user" && m.SlashCommand == "/deploy" {
			found = true
			if m.SlashModelAlias != "claude-sonnet" {
				t.Errorf("SlashModelAlias = %q, want %q", m.SlashModelAlias, "claude-sonnet")
			}
			if m.SlashModelEffective != "claude-sonnet-4-20250514" {
				t.Errorf("SlashModelEffective = %q, want %q", m.SlashModelEffective, "claude-sonnet-4-20250514")
			}
		}
	}

	if !found {
		t.Fatal("no user message with SlashCommand=/deploy after flatten")
	}
}

// TestSlashModelProvenanceOmittedWhenEmpty verifies that model provenance
// fields remain empty on non-slash user turns.
func TestSlashModelProvenanceOmittedWhenEmpty(t *testing.T) {
	conv := CreateConversation("slash-model-prov-empty-test", "sys", "model")

	AddUserMessage(conv, "hello")

	msgs := flattenEntries(conv)

	for _, m := range msgs {
		if m.Role == "user" {
			if m.SlashModelAlias != "" {
				t.Errorf("SlashModelAlias = %q, want empty for non-slash turn", m.SlashModelAlias)
			}
			if m.SlashModelEffective != "" {
				t.Errorf("SlashModelEffective = %q, want empty for non-slash turn", m.SlashModelEffective)
			}
		}
	}
}

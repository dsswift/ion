package conversation

import (
	"encoding/json"
	"strings"
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

func TestImplementationPhaseProvenanceRoundTrip(t *testing.T) {
	conv := CreateConversation("implementation-phase-test", "sys", "model")
	entry := AddUserMessageWithInvocation(conv, "expanded implementation instructions", SlashInvocation{
		Command: "/implement",
		Source:  "ion",
	})
	SetImplementationPhase(entry, true)

	stored := asMessageData(entry.Data)
	if stored == nil || !stored.ImplementationPhase {
		t.Fatalf("persisted implementation phase = %#v, want true", stored)
	}
	persisted, err := json.Marshal(stored)
	if err != nil {
		t.Fatalf("marshal MessageData: %v", err)
	}
	if !strings.Contains(string(persisted), `"implementationPhase":true`) {
		t.Fatalf("persisted MessageData = %s, want implementationPhase", persisted)
	}

	msgs := flattenEntries(conv)
	if len(msgs) != 1 || !msgs[0].ImplementationPhase {
		t.Fatalf("flattened implementation phase = %#v, want true", msgs)
	}
	flattened, err := json.Marshal(msgs[0])
	if err != nil {
		t.Fatalf("marshal SessionMessage: %v", err)
	}
	if !strings.Contains(string(flattened), `"implementationPhase":true`) {
		t.Fatalf("flattened SessionMessage = %s, want implementationPhase", flattened)
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

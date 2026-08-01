package types

import (
	"encoding/json"
	"testing"
)

// TestPromptInjectedWireShape pins the serialized shape of the event that
// carries an engine-side injection to consumers.
//
// The contract manifest (testdata/contracts.json) covers the field NAME set
// under the "prompt_injected" entry, so a renamed or dropped field already
// fails TestContractManifest. What the manifest does NOT cover is omitempty
// behaviour: whether a false MachineAuthored is present-as-false or absent.
// That distinction is load-bearing for consumers decoding into a language
// where an absent key and an explicit false differ, so it gets pinned here.
func TestPromptInjectedWireShape(t *testing.T) {
	t.Run("machine-authored injection carries the flag", func(t *testing.T) {
		raw, err := json.Marshal(PromptInjectedEvent{
			Prompt:          "check in on your dispatches",
			Origin:          "ion-dev",
			Kind:            string(InjectionKindCheckIn),
			MachineAuthored: true,
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var got map[string]any
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if got["kind"] != "checkin" {
			t.Errorf("kind = %v, want %q", got["kind"], "checkin")
		}
		if got["machineAuthored"] != true {
			t.Errorf("machineAuthored = %v, want true (a machine-authored injection "+
				"must say so on the wire; consumers read this instead of matching kinds)",
				got["machineAuthored"])
		}
	})

	t.Run("user-authored injection omits the flag", func(t *testing.T) {
		raw, err := json.Marshal(PromptInjectedEvent{
			Prompt: "an extension-initiated turn with no classification",
			Origin: "some-extension",
		})
		if err != nil {
			t.Fatalf("marshal: %v", err)
		}

		var got map[string]any
		if err := json.Unmarshal(raw, &got); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if _, present := got["machineAuthored"]; present {
			t.Errorf("machineAuthored present on an unclassified injection (%s); it is "+
				"omitempty so the false case stays off the wire", raw)
		}
		if _, present := got["kind"]; present {
			t.Errorf("kind present when empty (%s); it is omitempty", raw)
		}
	})
}

// TestEngineEventPromptInjectedWireShape pins the same two properties on the
// outbound EngineEvent, which is what actually reaches the socket.
// PromptInjectedEvent is the internal normalized variant; a consumer never sees
// it directly, so pinning only that shape would leave the real wire untested.
func TestEngineEventPromptInjectedWireShape(t *testing.T) {
	raw, err := json.Marshal(EngineEvent{
		Type:                          "engine_prompt_injected",
		InjectedPrompt:                "dispatch result",
		InjectedPromptOrigin:          "ion-dev",
		InjectedPromptKind:            string(InjectionKindAgentCompletion),
		InjectedPromptMachineAuthored: true,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}

	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["injectedPromptKind"] != "agent_completion" {
		t.Errorf("injectedPromptKind = %v, want %q", got["injectedPromptKind"], "agent_completion")
	}
	if got["injectedPromptMachineAuthored"] != true {
		t.Errorf("injectedPromptMachineAuthored = %v, want true", got["injectedPromptMachineAuthored"])
	}

	// The unclassified case must not carry the flag.
	rawPlain, err := json.Marshal(EngineEvent{
		Type:           "engine_prompt_injected",
		InjectedPrompt: "plain turn",
	})
	if err != nil {
		t.Fatalf("marshal plain: %v", err)
	}
	var plain map[string]any
	if err := json.Unmarshal(rawPlain, &plain); err != nil {
		t.Fatalf("unmarshal plain: %v", err)
	}
	if _, present := plain["injectedPromptMachineAuthored"]; present {
		t.Errorf("injectedPromptMachineAuthored present on an unclassified injection: %s", rawPlain)
	}
}

// TestSessionMessageCarriesMachineAuthored pins the reload side of the same
// contract. A consumer's history filter and its live-event filter must be able
// to read the SAME field, or the transcript changes shape when history
// rehydrates — the divergence this field exists to remove.
func TestSessionMessageCarriesMachineAuthored(t *testing.T) {
	raw, err := json.Marshal(SessionMessage{
		Role:            "user",
		Content:         "dispatch result",
		InjectionKind:   string(InjectionKindAgentCompletion),
		MachineAuthored: true,
	})
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	var got map[string]any
	if err := json.Unmarshal(raw, &got); err != nil {
		t.Fatalf("unmarshal: %v", err)
	}
	if got["machineAuthored"] != true {
		t.Errorf("machineAuthored = %v, want true on a reloaded agent_completion row",
			got["machineAuthored"])
	}
	if got["injectionKind"] != "agent_completion" {
		t.Errorf("injectionKind = %v, want %q", got["injectionKind"], "agent_completion")
	}
}

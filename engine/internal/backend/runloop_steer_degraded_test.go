package backend

import (
	"encoding/json"
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// Degraded-steer marker persistence.
//
// A ctx.steerSelf delivery that finds no live run becomes a fresh prompt. The
// live-run path (drainSteer, runloop_steer.go) persists a steer marker beside
// the injected turn; the degraded path must persist the same marker, or the two
// paths disagree and a machine turn that woke the agent leaves no trace in the
// transcript at all.
//
// The trigger is RunOptions.SteerDegraded, deliberately NOT an injection kind.
// The kind records who authored the turn; degradation records how it arrived.
// Both are independently true: a check-in can be steered onto a live run or
// degrade to a prompt, and a human steering an idle run degrades with an EMPTY
// kind. Keying the marker off a kind would miss that last case entirely.

// TestAppendInbound_DegradedSteer_PersistsMarker pins that a degraded steer
// writes the classified user entry AND a following steer marker.
//
// Revert-red: drop the appendDegradedSteerMarker call and the marker count goes
// to zero.
func TestAppendInbound_DegradedSteer_PersistsMarker(t *testing.T) {
	conv := conversation.CreateConversation("test-degraded-steer", "sys", "model")
	prompt := "[SYSTEM] Dispatch check-in\n\nYou have been idle."

	entry := AppendInboundUserMessage(conv, &types.RunOptions{
		Prompt:        prompt,
		InjectionKind: string(types.InjectionKindCheckIn),
		SteerDegraded: true,
	})
	if entry == nil {
		t.Fatal("expected a persisted user entry for the degraded steer")
	}

	var userEntries, steerMarkers int
	for _, e := range conv.Entries {
		switch e.Type {
		case conversation.EntryMessage:
			md := messageDataOf(t, e)
			if md.Role != "user" {
				continue
			}
			userEntries++
			// The kind is untouched by the degradation flag — the harness's own
			// classification must survive.
			if md.InjectionKind != string(types.InjectionKindCheckIn) {
				t.Errorf("user entry InjectionKind = %q, want %q", md.InjectionKind, types.InjectionKindCheckIn)
			}
			if !md.MachineAuthored {
				t.Error("a checkin turn must persist as machine-authored")
			}
		case conversation.EntrySteerMarker:
			steerMarkers++
			if sd := steerMarkerDataOf(t, e); sd.MessageLength != len(prompt) {
				t.Errorf("steer marker MessageLength = %d, want %d", sd.MessageLength, len(prompt))
			}
		}
	}

	if userEntries != 1 {
		t.Errorf("expected exactly 1 user entry, got %d", userEntries)
	}
	if steerMarkers != 1 {
		t.Errorf("expected exactly 1 steer marker for a degraded steer, got %d — "+
			"without it the degraded delivery leaves no trace in the transcript", steerMarkers)
	}
}

// A human steering an idle run degrades with NO kind. This is the case a
// kind-keyed marker would have missed, so it is pinned explicitly.
func TestAppendInbound_DegradedSteer_KindlessStillMarks(t *testing.T) {
	conv := conversation.CreateConversation("test-degraded-kindless", "sys", "model")

	AppendInboundUserMessage(conv, &types.RunOptions{
		Prompt:        "actually, check the other branch too",
		SteerDegraded: true,
	})

	var steerMarkers int
	for _, e := range conv.Entries {
		if e.Type == conversation.EntrySteerMarker {
			steerMarkers++
		}
	}
	if steerMarkers != 1 {
		t.Errorf("a kindless degraded steer must still persist its marker, got %d", steerMarkers)
	}
}

// Without the flag there is no marker: an ordinary injection is not a steer.
func TestAppendInbound_InjectionKinds_NoMarkerWithoutDegradation(t *testing.T) {
	kinds := []types.InjectionKind{
		types.InjectionKindAgentCompletion,
		types.InjectionKindBackgroundTaskCompletion,
		types.InjectionKindSlashCommand,
		types.InjectionKindCheckIn,
	}
	for _, kind := range kinds {
		t.Run(string(kind), func(t *testing.T) {
			conv := conversation.CreateConversation("test-no-marker", "sys", "model")

			AppendInboundUserMessage(conv, &types.RunOptions{
				Prompt:        "payload body",
				InjectionKind: string(kind),
			})

			for _, e := range conv.Entries {
				if e.Type == conversation.EntrySteerMarker {
					t.Errorf("kind %q without SteerDegraded must not persist a steer marker", kind)
				}
			}
		})
	}
}

// An ordinary client-submitted turn is untouched by the marker logic.
func TestAppendInbound_OrdinaryPrompt_NoSteerMarker(t *testing.T) {
	conv := conversation.CreateConversation("test-ordinary", "sys", "model")

	AppendInboundUserMessage(conv, &types.RunOptions{Prompt: "what should I work on?"})

	for _, e := range conv.Entries {
		if e.Type == conversation.EntrySteerMarker {
			t.Error("an ordinary user turn must not persist a steer marker")
		}
		if e.Type == conversation.EntryMessage {
			if md := messageDataOf(t, e); md.InjectionKind != "" {
				t.Errorf("an ordinary user turn must carry no InjectionKind, got %q", md.InjectionKind)
			}
		}
	}
}

// A degraded steer that also carries attachments or a slash invocation must
// still mark. This pins the restructure that moved the marker OUT of the
// kind-bearing switch arm and applied it to every append shape.
func TestAppendInbound_DegradedSteer_MarksAcrossAppendShapes(t *testing.T) {
	t.Run("with attachments", func(t *testing.T) {
		conv := conversation.CreateConversation("test-degraded-attach", "sys", "model")
		AppendInboundUserMessage(conv, &types.RunOptions{
			Prompt:        "look at this",
			SteerDegraded: true,
			Attachments:   []types.ImageAttachment{{Path: "/tmp/a.png", MediaType: "image/png"}},
		})
		if !hasSteerMarker(conv) {
			t.Error("a degraded steer carrying attachments must still persist its marker")
		}
	})

	t.Run("with slash invocation", func(t *testing.T) {
		conv := conversation.CreateConversation("test-degraded-slash", "sys", "model")
		AppendInboundUserMessage(conv, &types.RunOptions{
			Prompt:               "expanded body",
			SteerDegraded:        true,
			ResolvedSlashCommand: "/align",
		})
		if !hasSteerMarker(conv) {
			t.Error("a degraded steer resolving a slash command must still persist its marker")
		}
	})
}

func hasSteerMarker(conv *conversation.Conversation) bool {
	for _, e := range conv.Entries {
		if e.Type == conversation.EntrySteerMarker {
			return true
		}
	}
	return false
}

// messageDataOf decodes an EntryMessage's payload. AppendEntry stores Data as
// the concrete struct in-process and as JSON after a round-trip, so both
// shapes are handled.
func messageDataOf(t *testing.T, e conversation.SessionEntry) conversation.MessageData {
	t.Helper()
	switch d := e.Data.(type) {
	case conversation.MessageData:
		return d
	case *conversation.MessageData:
		return *d
	}
	raw, err := json.Marshal(e.Data)
	if err != nil {
		t.Fatalf("marshal message data: %v", err)
	}
	var md conversation.MessageData
	if err := json.Unmarshal(raw, &md); err != nil {
		t.Fatalf("unmarshal message data: %v", err)
	}
	return md
}

// steerMarkerDataOf decodes an EntrySteerMarker's payload, handling the same
// two shapes as messageDataOf.
func steerMarkerDataOf(t *testing.T, e conversation.SessionEntry) conversation.SteerMarkerData {
	t.Helper()
	switch d := e.Data.(type) {
	case conversation.SteerMarkerData:
		return d
	case *conversation.SteerMarkerData:
		return *d
	}
	raw, err := json.Marshal(e.Data)
	if err != nil {
		t.Fatalf("marshal steer marker data: %v", err)
	}
	var sd conversation.SteerMarkerData
	if err := json.Unmarshal(raw, &sd); err != nil {
		t.Fatalf("unmarshal steer marker data: %v", err)
	}
	return sd
}

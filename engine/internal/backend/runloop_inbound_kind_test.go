package backend

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/types"
)

// entryClassification pulls the persisted classification off the tree entry the
// append produced. It reads the entry rather than the flattened row on purpose:
// the flatten path re-derives MachineAuthored from the kind, which would mask a
// missing persisted kind behind a correct-looking derived value only when the
// kind itself survived. The entry is where the leak actually happened.
func entryClassification(t *testing.T, conv *conversation.Conversation) (string, bool) {
	t.Helper()
	if len(conv.Entries) != 1 {
		t.Fatalf("expected exactly 1 persisted entry, got %d", len(conv.Entries))
	}
	md, ok := conv.Entries[0].Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data is %T, want conversation.MessageData", conv.Entries[0].Data)
	}
	return md.InjectionKind, md.MachineAuthored
}

// TestAppendInboundUserMessage_KindSurvivesEveryAppendShape pins the invariant
// that broke in production: an injected turn's classification must reach the
// persisted entry NO MATTER which append shape the prompt's other properties
// select.
//
// appendInboundUserEntry chooses one arm of a mutually-exclusive switch on
// provenance (slash invocation, attachments, background work, injection kind,
// plain). The kind arm sat LAST, so any prompt that also carried attachments or
// a slash expansion took an earlier arm and the kind was silently dropped. The
// entry then persisted with no InjectionKind and no MachineAuthored, and both
// clients — which suppress on exactly those two fields — rendered an engine
// steering message as a user turn on historical reload.
//
// This is not hypothetical. Run recovery replays the interrupted run's original
// PromptOverrides, attachments included, alongside the machine-authored
// "[SYSTEM] This run was interrupted..." continuation prompt. Every recovery of
// a run whose user turn had pasted an image produced a leaked row on disk.
//
// Revert-red guarantee: restoring the kind check to a late switch arm makes the
// attachments and slash sub-tests fail, because their entries lose the kind.
func TestAppendInboundUserMessage_KindSurvivesEveryAppendShape(t *testing.T) {
	const kind = string(types.InjectionKindRunRecovery)

	cases := []struct {
		name string
		opts types.RunOptions
	}{
		{
			name: "plain text",
			opts: types.RunOptions{Prompt: "[SYSTEM] continue", InjectionKind: kind},
		},
		{
			name: "with attachments",
			opts: types.RunOptions{
				Prompt:        "[SYSTEM] continue",
				InjectionKind: kind,
				Attachments: []types.ImageAttachment{{
					MediaType: "image/png",
					Data:      "aGVsbG8=",
				}},
			},
		},
		{
			name: "with slash invocation",
			opts: types.RunOptions{
				Prompt:               "expanded template body",
				InjectionKind:        kind,
				ResolvedSlashCommand: "/align",
			},
		},
	}

	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			conv := conversation.CreateConversation("test-inbound-kind", "sys", "model")
			if entry := AppendInboundUserMessage(conv, &tc.opts); entry == nil {
				t.Fatal("expected a persisted tree entry")
			}

			gotKind, gotMachine := entryClassification(t, conv)
			if gotKind != kind {
				t.Errorf("persisted InjectionKind = %q, want %q", gotKind, kind)
			}
			if !gotMachine {
				t.Error("persisted MachineAuthored = false, want true: a client suppresses on this flag, so a false value leaks the turn into the transcript")
			}
		})
	}
}

func TestAppendInboundUserMessage_DisplayPromptKeepsProviderInstructionsOutOfTranscript(t *testing.T) {
	conv := conversation.CreateConversation("test-display-prompt", "sys", "model")
	opts := types.RunOptions{
		Prompt:        "answers plus provider-only continuation instruction",
		DisplayPrompt: "**Which store?**\n- Postgres",
		InjectionKind: string(types.InjectionKindStructuredAnswer),
		Attachments: []types.ImageAttachment{{
			MediaType: "image/png",
			Data:      "aGVsbG8=",
		}},
	}

	entry := AppendInboundUserMessage(conv, &opts)
	if entry == nil {
		t.Fatal("expected a persisted tree entry")
	}
	md, ok := entry.Data.(conversation.MessageData)
	if !ok {
		t.Fatalf("entry data is %T, want conversation.MessageData", entry.Data)
	}
	display := contentBlockText(t, md.Content)
	provider := contentBlockText(t, md.LlmContent)
	if display != "**Which store?**\n- Postgres" {
		t.Fatalf("display content = %q", display)
	}
	if provider != "answers plus provider-only continuation instruction" {
		t.Fatalf("provider content = %q", provider)
	}
	if len(conv.Messages) != 1 || contentBlockText(t, conv.Messages[0].Content) != provider {
		t.Fatal("live provider message did not use provider content")
	}
	if md.InjectionKind != string(types.InjectionKindStructuredAnswer) || md.MachineAuthored {
		t.Fatalf("structured answer classification = kind %q machine=%v", md.InjectionKind, md.MachineAuthored)
	}
	if blocks, ok := md.Content.([]types.LlmContentBlock); !ok || len(blocks) != 2 || blocks[0].Type != "image" || blocks[1].Type != "text" {
		t.Fatalf("display content did not retain media-first prompt attachment: %#v", md.Content)
	}
}

func contentBlockText(t *testing.T, content any) string {
	t.Helper()
	blocks, ok := content.([]types.LlmContentBlock)
	if !ok || len(blocks) == 0 {
		t.Fatalf("content is %T, want non-empty []types.LlmContentBlock", content)
	}
	for _, block := range blocks {
		if block.Type == "text" {
			return block.Text
		}
	}
	t.Fatal("content has no text block")
	return ""
}

// TestAppendInboundUserMessage_BackgroundWorkKeepsItsOwnKind pins that the
// background-work arm is unaffected by the fix. That arm stamps the kind from
// the BackgroundWorkInfo payload, which is the authoritative source for a
// background delivery, so the classification must still come from the payload.
func TestAppendInboundUserMessage_BackgroundWorkKeepsItsOwnKind(t *testing.T) {
	conv := conversation.CreateConversation("test-inbound-bgwork", "sys", "model")
	opts := types.RunOptions{
		Prompt: "[SYSTEM] background command finished",
		BackgroundWork: &types.BackgroundWorkInfo{
			Kind:         string(types.InjectionKindBackgroundTaskCompletion),
			DeliveryMode: "wake",
			Items: []types.BackgroundWorkItem{{
				ID:     "task-1",
				Source: types.BackgroundWorkSourceBash,
				Status: "completed",
			}},
		},
	}

	if entry := AppendInboundUserMessage(conv, &opts); entry == nil {
		t.Fatal("expected a persisted tree entry")
	}

	gotKind, gotMachine := entryClassification(t, conv)
	if want := string(types.InjectionKindBackgroundTaskCompletion); gotKind != want {
		t.Errorf("persisted InjectionKind = %q, want %q", gotKind, want)
	}
	if !gotMachine {
		t.Error("persisted MachineAuthored = false, want true")
	}
}

// TestAppendInboundUserMessage_OrdinaryTurnStaysUnclassified pins the other
// side of the contract. A genuine user turn — including one with attachments,
// which is the shape the fix touches — must persist with no kind and
// MachineAuthored false, or the fix would hide real user messages.
func TestAppendInboundUserMessage_OrdinaryTurnStaysUnclassified(t *testing.T) {
	conv := conversation.CreateConversation("test-inbound-ordinary", "sys", "model")
	opts := types.RunOptions{
		Prompt: "here is a screenshot of the bug",
		Attachments: []types.ImageAttachment{{
			MediaType: "image/png",
			Data:      "aGVsbG8=",
		}},
	}

	if entry := AppendInboundUserMessage(conv, &opts); entry == nil {
		t.Fatal("expected a persisted tree entry")
	}

	gotKind, gotMachine := entryClassification(t, conv)
	if gotKind != "" {
		t.Errorf("persisted InjectionKind = %q, want empty for a user turn", gotKind)
	}
	if gotMachine {
		t.Error("persisted MachineAuthored = true, want false: a real user turn must never be suppressed")
	}
}

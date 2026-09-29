package studio

import (
	"context"
	"encoding/json"
	"os"
	"strings"
	"testing"
	"time"

	ion "github.com/dsswift/ion/sdk/go"
)

type published struct {
	op   ion.ResourceOp
	item ion.ResourceItem
}

type fakeHost struct {
	declared []string
	handler  ion.ResourceQueryHandler
	sent     []published
}

func (h *fakeHost) Declare(_ context.Context, kind string) (Publisher, error) {
	h.declared = append(h.declared, kind)
	return h, nil
}

func (h *fakeHost) OnQuery(_ string, handler ion.ResourceQueryHandler) { h.handler = handler }

func (h *fakeHost) Publish(_ context.Context, op ion.ResourceOp, item ion.ResourceItem) error {
	h.sent = append(h.sent, published{op: op, item: item})
	return nil
}

func newComposer(t *testing.T) (*Composer, *fakeHost) {
	t.Helper()
	host := &fakeHost{}
	composer, err := NewComposer(context.Background(), host)
	if err != nil {
		t.Fatalf("NewComposer: %v", err)
	}
	return composer, host
}

// The contract file is what the TypeScript flavor and Studio's parser are
// pinned to as well; this pins the Go flavor to the same bytes.
func TestPublishesExactlyTheContractShape(t *testing.T) {
	raw, err := os.ReadFile("../contract.json")
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	var contract struct {
		ControlKindPrefix string `json:"controlKindPrefix"`
		ComposerAction    struct {
			Kind    string           `json:"kind"`
			Example ion.ResourceItem `json:"example"`
		} `json:"composerAction"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("parse contract: %v", err)
	}
	if ControlKindPrefix != contract.ControlKindPrefix || ComposerActionKind != contract.ComposerAction.Kind {
		t.Fatalf("kind constants drifted from the contract")
	}
	want := contract.ComposerAction.Example
	got, err := ComposerAction{ID: "briefing", Label: "Briefing", Icon: "Newspaper", Command: "/briefing"}.Item(want.CreatedAt)
	if err != nil {
		t.Fatalf("Item: %v", err)
	}
	var gotContent, wantContent map[string]string
	if err := json.Unmarshal([]byte(got.Content), &gotContent); err != nil {
		t.Fatalf("content is not JSON: %v", err)
	}
	if err := json.Unmarshal([]byte(want.Content), &wantContent); err != nil {
		t.Fatalf("contract content is not JSON: %v", err)
	}
	if len(gotContent) != len(wantContent) {
		t.Fatalf("content fields = %v, want %v", gotContent, wantContent)
	}
	for k, v := range wantContent {
		if gotContent[k] != v {
			t.Fatalf("content[%q] = %q, want %q", k, gotContent[k], v)
		}
	}
	got.Content, want.Content = "", ""
	if got.ID != want.ID || got.Kind != want.Kind || got.Title != want.Title || got.CreatedAt != want.CreatedAt {
		t.Fatalf("item = %+v, want %+v", got, want)
	}
}

func TestRegisterServesTheSnapshotWithoutPublishing(t *testing.T) {
	composer, host := newComposer(t)
	if len(host.declared) != 1 || host.declared[0] != ComposerActionKind {
		t.Fatalf("declared = %v", host.declared)
	}
	if err := composer.Register(
		ComposerAction{ID: "b", Label: "B", Command: "/b"},
		ComposerAction{ID: "a", Label: "A", Command: "/a", ConversationID: "conv-1"},
	); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if len(host.sent) != 0 {
		t.Fatalf("Register published %d deltas, want 0", len(host.sent))
	}
	all, err := host.handler(context.Background(), ion.ResourceFilter{Kind: ComposerActionKind})
	if err != nil || len(all) != 2 || all[0].ID != "a" {
		t.Fatalf("snapshot = %+v, err %v", all, err)
	}
	other, _ := host.handler(context.Background(), ion.ResourceFilter{Kind: ComposerActionKind, ConversationID: "conv-2"})
	if len(other) != 1 || other[0].ID != "b" {
		t.Fatalf("conversation-scoped snapshot = %+v", other)
	}
}

func TestAddReplaceAndRemovePublishDeltas(t *testing.T) {
	composer, host := newComposer(t)
	composer.now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	ctx := context.Background()
	if err := composer.AddAction(ctx, ComposerAction{ID: "a", Label: "A", Command: "/a"}); err != nil {
		t.Fatal(err)
	}
	if err := composer.AddAction(ctx, ComposerAction{ID: "a", Label: "A again", Command: "/a"}); err != nil {
		t.Fatal(err)
	}
	if err := composer.RemoveAction(ctx, "a"); err != nil {
		t.Fatal(err)
	}
	if err := composer.RemoveAction(ctx, "never-added"); err != nil {
		t.Fatal(err)
	}
	ops := []ion.ResourceOp{}
	for _, p := range host.sent {
		ops = append(ops, p.op)
	}
	if len(ops) != 3 || ops[0] != ion.ResourceOpCreate || ops[1] != ion.ResourceOpUpdate || ops[2] != ion.ResourceOpDelete {
		t.Fatalf("ops = %v", ops)
	}
	if host.sent[1].item.CreatedAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("replace changed createdAt to %q", host.sent[1].item.CreatedAt)
	}
	left, _ := host.handler(ctx, ion.ResourceFilter{Kind: ComposerActionKind})
	if len(left) != 0 {
		t.Fatalf("snapshot after remove = %+v", left)
	}
}

func TestRefusesAnythingThatIsNotASlashCommand(t *testing.T) {
	composer, host := newComposer(t)
	err := composer.AddAction(context.Background(), ComposerAction{ID: "x", Label: "X", Command: "rm -rf /"})
	if err == nil || !strings.Contains(err.Error(), "slash command") {
		t.Fatalf("err = %v", err)
	}
	if len(host.sent) != 0 {
		t.Fatalf("an invalid action was published")
	}
}

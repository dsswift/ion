package studio

import (
	"context"
	"encoding/json"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	ion "github.com/dsswift/ion/sdk/go"
)

func newLinks(t *testing.T) (*Links, *fakeHost) {
	t.Helper()
	host := &fakeHost{}
	links, err := NewLinks(context.Background(), host)
	if err != nil {
		t.Fatalf("NewLinks: %v", err)
	}
	return links, host
}

func TestLinkRoutePublishesExactlyTheContractShape(t *testing.T) {
	raw, err := os.ReadFile("../contract.json")
	if err != nil {
		t.Fatalf("read contract: %v", err)
	}
	var contract struct {
		LinkRoute struct {
			Kind      string           `json:"kind"`
			IDPattern string           `json:"idPattern"`
			Example   ion.ResourceItem `json:"example"`
		} `json:"linkRoute"`
	}
	if err := json.Unmarshal(raw, &contract); err != nil {
		t.Fatalf("parse contract: %v", err)
	}
	if LinkRouteKind != contract.LinkRoute.Kind || routeIDPattern.String() != contract.LinkRoute.IDPattern {
		t.Fatalf("link route kind or id pattern drifted from the contract")
	}
	want := contract.LinkRoute.Example
	got, err := LinkRoute{ID: "open-briefing", Label: "Open briefing", Command: "/briefing"}.Item(want.CreatedAt)
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
	if got.ID != want.ID || got.Kind != want.Kind || got.Title != want.Title || got.CreatedAt != want.CreatedAt || got.ConversationID != "" {
		t.Fatalf("item = %+v, want %+v", got, want)
	}
	if !regexp.MustCompile(contract.LinkRoute.IDPattern).MatchString(got.ID) {
		t.Fatalf("example id %q does not match the contract pattern", got.ID)
	}
}

func TestLinksRegisterServesTheSnapshotWithoutPublishing(t *testing.T) {
	links, host := newLinks(t)
	if len(host.declared) != 1 || host.declared[0] != LinkRouteKind {
		t.Fatalf("declared = %v", host.declared)
	}
	if err := links.Register(
		LinkRoute{ID: "b", Label: "B", Command: "/b"},
		LinkRoute{ID: "a", Label: "A", Command: "/a", ConversationID: "conv-1"},
	); err != nil {
		t.Fatalf("Register: %v", err)
	}
	if len(host.sent) != 0 {
		t.Fatalf("Register published %d deltas, want 0", len(host.sent))
	}
	all, err := host.handler(context.Background(), ion.ResourceFilter{Kind: LinkRouteKind})
	if err != nil || len(all) != 2 || all[0].ID != "a" || all[0].Kind != LinkRouteKind {
		t.Fatalf("snapshot = %+v, err %v", all, err)
	}
	other, _ := host.handler(context.Background(), ion.ResourceFilter{Kind: LinkRouteKind, ConversationID: "conv-2"})
	if len(other) != 1 || other[0].ID != "b" {
		t.Fatalf("conversation-scoped snapshot = %+v", other)
	}
}

func TestLinksAddReplaceAndRemovePublishDeltas(t *testing.T) {
	links, host := newLinks(t)
	links.now = func() time.Time { return time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC) }
	ctx := context.Background()
	if err := links.AddRoute(ctx, LinkRoute{ID: "r", Label: "R", Command: "/r"}); err != nil {
		t.Fatal(err)
	}
	if err := links.AddRoute(ctx, LinkRoute{ID: "r", Label: "R again", Command: "/r now"}); err != nil {
		t.Fatal(err)
	}
	if err := links.RemoveRoute(ctx, "r"); err != nil {
		t.Fatal(err)
	}
	if err := links.RemoveRoute(ctx, "never-added"); err != nil {
		t.Fatal(err)
	}
	if len(host.sent) != 3 || host.sent[0].op != ion.ResourceOpCreate || host.sent[1].op != ion.ResourceOpUpdate || host.sent[2].op != ion.ResourceOpDelete {
		t.Fatalf("sent = %+v", host.sent)
	}
	if host.sent[1].item.CreatedAt != "2026-01-01T00:00:00Z" {
		t.Fatalf("replace changed createdAt to %q", host.sent[1].item.CreatedAt)
	}
	left, _ := host.handler(ctx, ion.ResourceFilter{Kind: LinkRouteKind})
	if len(left) != 0 {
		t.Fatalf("snapshot after remove = %+v", left)
	}
}

func TestLinksRefuseABadIDLabelOrCommand(t *testing.T) {
	cases := []struct {
		name  string
		route LinkRoute
		want  string
	}{
		{"empty id", LinkRoute{Label: "X", Command: "/x"}, "id"},
		{"id with a slash", LinkRoute{ID: "a/b", Label: "X", Command: "/x"}, "id"},
		{"id over 64", LinkRoute{ID: strings.Repeat("a", 65), Label: "X", Command: "/x"}, "id"},
		{"empty label", LinkRoute{ID: "x", Command: "/x"}, "label"},
		{"label over 80", LinkRoute{ID: "x", Label: strings.Repeat("l", 81), Command: "/x"}, "label"},
		{"not a slash command", LinkRoute{ID: "x", Label: "X", Command: "rm -rf /"}, "slash command"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			links, host := newLinks(t)
			err := links.AddRoute(context.Background(), tc.route)
			if err == nil || !strings.Contains(err.Error(), tc.want) {
				t.Fatalf("err = %v, want it to mention %q", err, tc.want)
			}
			if len(host.sent) != 0 {
				t.Fatalf("an invalid route was published")
			}
		})
	}
}

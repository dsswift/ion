package conversation

import "testing"

// planMarker appends an EntryPlanMarker for path/slug, mirroring what the engine
// persists when a plan file is written.
func planMarker(conv *Conversation, path, slug string) {
	AppendEntry(conv, EntryPlanMarker, PlanMarkerData{
		Operation:    "created",
		PlanFilePath: path,
		PlanSlug:     slug,
	})
}

// implTurn appends a user turn flagged as the implementation phase, the durable
// signal LatestUnimplementedPlan reads to decide a plan is "spent".
func implTurn(conv *Conversation) {
	entry := AddUserMessage(conv, "implement it")
	SetImplementationPhase(entry, true)
}

func TestLatestUnimplementedPlan(t *testing.T) {
	t.Run("no plan marker → not found", func(t *testing.T) {
		conv := CreateConversation("no-plan", "sys", "m")
		AddUserMessage(conv, "hi")
		AddAssistantMessageNoUsage(conv, nil)
		if p, s, found := LatestUnimplementedPlan(conv); found {
			t.Fatalf("expected no plan, got found=%v path=%q slug=%q", found, p, s)
		}
	})

	t.Run("plan with no implementation → kept", func(t *testing.T) {
		conv := CreateConversation("plan-open", "sys", "m")
		AddUserMessage(conv, "make a plan")
		planMarker(conv, "/plans/brave-baking-otter.md", "brave-baking-otter")
		p, s, found := LatestUnimplementedPlan(conv)
		if !found || p != "/plans/brave-baking-otter.md" || s != "brave-baking-otter" {
			t.Fatalf("expected the open plan kept, got found=%v path=%q slug=%q", found, p, s)
		}
	})

	t.Run("plan implemented → not kept", func(t *testing.T) {
		conv := CreateConversation("plan-done", "sys", "m")
		planMarker(conv, "/plans/calm-hiking-finch.md", "calm-hiking-finch")
		implTurn(conv)
		if p, s, found := LatestUnimplementedPlan(conv); found {
			t.Fatalf("expected implemented plan not kept, got found=%v path=%q slug=%q", found, p, s)
		}
	})

	t.Run("older plan implemented, newer plan open → newer kept", func(t *testing.T) {
		conv := CreateConversation("two-plans", "sys", "m")
		planMarker(conv, "/plans/old-plan.md", "old-plan")
		implTurn(conv) // implements old-plan
		planMarker(conv, "/plans/new-plan.md", "new-plan")
		p, s, found := LatestUnimplementedPlan(conv)
		if !found || p != "/plans/new-plan.md" || s != "new-plan" {
			t.Fatalf("expected new-plan kept, got found=%v path=%q slug=%q", found, p, s)
		}
	})

	t.Run("latest plan implemented after an open older plan → not kept", func(t *testing.T) {
		// The verdict tracks the LATEST plan only: once the newest plan is
		// implemented, keep-plan retains nothing even if an earlier plan never
		// was — the conversation has moved past the newest plan.
		conv := CreateConversation("latest-done", "sys", "m")
		planMarker(conv, "/plans/first.md", "first")
		planMarker(conv, "/plans/second.md", "second")
		implTurn(conv) // implements second
		if p, s, found := LatestUnimplementedPlan(conv); found {
			t.Fatalf("expected nothing kept once latest plan implemented, got found=%v path=%q slug=%q", found, p, s)
		}
	})
}

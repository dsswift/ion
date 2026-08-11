package ion

import (
	"context"
	"os"
	"path/filepath"
	"testing"
)

// resources_test.go — resource declaration, query, and publish.
//
// The engine stores nothing here: it routes a client's subscription to the
// producing extension and fans out whatever the extension publishes. So the
// properties worth pinning are that a declaration reaches the engine on the
// right path, that a query reaches the right handler, and that a kind with no
// handler answers an empty snapshot rather than an error.

// TestPreInitResourceDeclarationDrains pins that a module-scope declaration
// rides the init handshake.
func TestPreInitResourceDeclarationDrains(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-preinit-test"))

	if _, err := fe.sdk.Resources().Declare(context.Background(), "briefing"); err != nil {
		t.Fatalf("declare: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	resources, ok := result["resources"].([]any)
	if !ok || len(resources) != 1 {
		t.Fatalf("init resources = %+v, want one entry", result["resources"])
	}
	decl, _ := resources[0].(map[string]any)
	if decl["kind"] != "briefing" {
		t.Errorf("kind = %v, want briefing", decl["kind"])
	}
}

// TestPostInitResourceDeclarationUsesRPC pins the post-init path.
func TestPostInitResourceDeclarationUsesRPC(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-postinit-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	done := make(chan error, 1)
	go func() {
		_, err := fe.sdk.Resources().Declare(context.Background(), "report")
		done <- err
	}()

	frame := fe.awaitMethod("ext/declare_resource")
	params, _ := frame["params"].(map[string]any)
	if params["kind"] != "report" {
		t.Errorf("declared kind = %v, want report", params["kind"])
	}
	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"ok": true})

	if err := <-done; err != nil {
		t.Fatalf("declare: %v", err)
	}
}

// TestResourceQueryReachesHandler pins the subscription path: the engine sends
// resource/query when a client subscribes, and the extension answers from its
// own store — because the engine has no store.
func TestResourceQueryReachesHandler(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-query-test"))

	gotFilter := make(chan ResourceFilter, 1)
	fe.sdk.Resources().OnQuery("briefing", func(c context.Context, filter ResourceFilter) ([]ResourceItem, error) {
		gotFilter <- filter
		return []ResourceItem{{
			ID: "b1", Kind: "briefing", Title: "Morning", Content: "text",
			CreatedAt: "2026-01-01T00:00:00Z",
		}}, nil
	})
	if _, err := fe.sdk.Resources().Declare(context.Background(), "briefing"); err != nil {
		t.Fatalf("declare: %v", err)
	}

	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(100, methodResourceQuery, map[string]any{
		"kind":   "briefing",
		"filter": map[string]any{"kind": "briefing", "limit": 10},
	})
	resp := fe.awaitResponse(100)

	filter := <-gotFilter
	if filter.Kind != "briefing" || filter.Limit != 10 {
		t.Errorf("filter = %+v, want kind briefing limit 10", filter)
	}

	items, ok := resp["result"].([]any)
	if !ok || len(items) != 1 {
		t.Fatalf("query result = %+v, want one item", resp["result"])
	}
	item, _ := items[0].(map[string]any)
	if item["id"] != "b1" || item["title"] != "Morning" {
		t.Errorf("item = %+v, want the briefing", item)
	}
}

// TestResourceQueryWithNoHandlerAnswersEmpty pins that a declared kind with no
// handler yet is an empty snapshot, not a failure. An extension that declares
// at startup and installs its handler later is normal, and erroring would
// break the client's subscription rather than showing it nothing.
func TestResourceQueryWithNoHandlerAnswersEmpty(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-nohandler-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	fe.request(101, methodResourceQuery, map[string]any{
		"kind": "unknown", "filter": map[string]any{"kind": "unknown"},
	})
	resp := fe.awaitResponse(101)

	items, ok := resp["result"].([]any)
	if !ok {
		t.Fatalf("result is not an array: %+v", resp)
	}
	if len(items) != 0 {
		t.Errorf("result = %+v, want an empty array", items)
	}
}

// TestResourcePublishSendsDelta pins the publish shape the engine fans out to
// every subscribed client.
func TestResourcePublishSendsDelta(t *testing.T) {
	fe := newFakeEngine(t, WithName("resource-publish-test"))
	fe.start()
	fe.doInit(ExtensionConfig{})

	handle := ResourceHandle{Kind: "briefing", reg: fe.sdk.resources}

	done := make(chan error, 1)
	go func() {
		done <- handle.Publish(context.Background(), ResourceOpCreate, ResourceItem{
			ID: "b2", Content: "new briefing", CreatedAt: "2026-01-02T00:00:00Z",
			ConversationID: "conv-1",
		})
	}()

	frame := fe.awaitMethod("ext/publish_resource")
	params, _ := frame["params"].(map[string]any)
	if params["kind"] != "briefing" || params["op"] != "create" {
		t.Errorf("publish = %+v, want kind briefing op create", params)
	}
	item, _ := params["item"].(map[string]any)
	if item["id"] != "b2" {
		t.Errorf("item.id = %v, want b2", item["id"])
	}
	// The handle fills in the kind so a caller does not have to repeat it.
	if item["kind"] != "briefing" {
		t.Errorf("item.kind = %v, want the handle's kind filled in", item["kind"])
	}
	// A conversation-scoped item belongs to that tab rather than the global
	// inbox, so the id must survive.
	if item["conversationId"] != "conv-1" {
		t.Errorf("item.conversationId = %v, want conv-1", item["conversationId"])
	}

	id, _ := frame["id"].(float64)
	fe.respond(id, map[string]any{"ok": true})
	if err := <-done; err != nil {
		t.Fatalf("publish: %v", err)
	}
}

// TestAgentToolsFromMarkdown pins the agent-file walk: frontmatter becomes
// typed fields, the body becomes the persona, unknown keys become meta, and a
// root agent is excluded by default because a root agent is the conversation
// rather than a dispatch target.
func TestAgentToolsFromMarkdown(t *testing.T) {
	dir := t.TempDir()
	agentsDir := filepath.Join(dir, "agents")
	if err := os.MkdirAll(agentsDir, 0o755); err != nil {
		t.Fatal(err)
	}

	specialist := `---
name: code-reviewer
parent: lead
description: code review
model: claude-fast
tools: [Read, Grep]
speciality: static analysis
---

You review code carefully.
`
	root := `---
name: lead
description: the orchestrator
---

You are the lead.
`
	if err := os.WriteFile(filepath.Join(agentsDir, "reviewer.md"), []byte(specialist), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(agentsDir, "lead.md"), []byte(root), 0o644); err != nil {
		t.Fatal(err)
	}

	fe := newFakeEngine(t, WithName("agent-tools-test"))
	if err := fe.sdk.RegisterAgentTools(RegisterAgentToolsOpts{Dir: agentsDir}); err != nil {
		t.Fatalf("RegisterAgentTools: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %+v, want only the parented specialist", tools)
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "dispatch_code_reviewer" {
		t.Errorf("tool name = %v, want dispatch_code_reviewer (dashes become underscores)", tool["name"])
	}
	if tool["description"] != "Dispatch the code review specialist" {
		t.Errorf("description = %v, want it built from the agent description", tool["description"])
	}
}

// TestSplitFrontmatterShapes pins the parser against the cases the engine's
// own frontmatter reader handles. This is a hand-rolled subset by design —
// matching the engine matters more than accepting general YAML — so the subset
// needs pinning.
func TestSplitFrontmatterShapes(t *testing.T) {
	t.Run("bare values and inline arrays", func(t *testing.T) {
		fields, body := splitFrontmatter("---\nname: x\ntools: [A, B , C]\n---\nbody text\n")
		if got := fields["name"]; len(got) != 1 || got[0] != "x" {
			t.Errorf("name = %v, want [x]", got)
		}
		if got := fields["tools"]; len(got) != 3 || got[0] != "A" || got[2] != "C" {
			t.Errorf("tools = %v, want [A B C] with each item trimmed", got)
		}
		if body != "body text\n" {
			t.Errorf("body = %q, want the text after the fence", body)
		}
	})

	t.Run("no fence means the whole file is body", func(t *testing.T) {
		fields, body := splitFrontmatter("just a persona\n")
		if len(fields) != 0 {
			t.Errorf("fields = %v, want none", fields)
		}
		if body != "just a persona\n" {
			t.Errorf("body = %q", body)
		}
	})

	t.Run("horizontal rule in the body is not a closing fence", func(t *testing.T) {
		_, body := splitFrontmatter("---\nname: x\n---\nintro\n\n---\n\nmore\n")
		if body != "intro\n\n---\n\nmore\n" {
			t.Errorf("body = %q, want the rule preserved inside the body", body)
		}
	})

	t.Run("CRLF parses like LF", func(t *testing.T) {
		fields, body := splitFrontmatter("---\r\nname: y\r\n---\r\nbody\r\n")
		if got := fields["name"]; len(got) != 1 || got[0] != "y" {
			t.Errorf("name = %v, want [y]", got)
		}
		if body != "body\n" {
			t.Errorf("body = %q, want normalised line endings", body)
		}
	})

	t.Run("leading blank lines are trimmed from the body", func(t *testing.T) {
		_, body := splitFrontmatter("---\nname: z\n---\n\n\nPersona starts here.\n")
		if body != "Persona starts here.\n" {
			t.Errorf("body = %q, want leading blanks trimmed", body)
		}
	})

	t.Run("unterminated fence is treated as a body", func(t *testing.T) {
		fields, body := splitFrontmatter("---\nname: broken\nno closing fence\n")
		if len(fields) != 0 {
			t.Errorf("fields = %v, want none for an unterminated fence", fields)
		}
		if body == "" {
			t.Error("body is empty; the content should be preserved")
		}
	})
}

// TestMissingAgentsDirIsNotAnError pins that an extension with no agents
// directory registers nothing and reports success. Most extensions have none.
func TestMissingAgentsDirIsNotAnError(t *testing.T) {
	fe := newFakeEngine(t, WithName("no-agents-test"))
	err := fe.sdk.RegisterAgentTools(RegisterAgentToolsOpts{
		Dir: filepath.Join(t.TempDir(), "does-not-exist"),
	})
	if err != nil {
		t.Fatalf("a missing agents directory should not be an error, got %v", err)
	}
}

// TestAgentToolCustomisation pins the override hooks: a caller can rename the
// tool, rewrite its description, and change which agents qualify.
func TestAgentToolCustomisation(t *testing.T) {
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "solo.md"),
		[]byte("---\nname: solo\n---\nI work alone.\n"), 0o644); err != nil {
		t.Fatal(err)
	}

	fe := newFakeEngine(t, WithName("agent-custom-test"))
	err := fe.sdk.RegisterAgentTools(RegisterAgentToolsOpts{
		Dir: dir,
		// Keep root agents, which the default filter would drop.
		Filter:      func(a DiscoveredAgent) bool { return true },
		ToolName:    func(a DiscoveredAgent) string { return "call_" + a.Name },
		Description: func(a DiscoveredAgent) string { return "custom: " + a.Name },
	})
	if err != nil {
		t.Fatalf("RegisterAgentTools: %v", err)
	}

	fe.start()
	result := fe.doInit(ExtensionConfig{})

	tools, _ := result["tools"].([]any)
	if len(tools) != 1 {
		t.Fatalf("tools = %+v, want the root agent kept by the custom filter", tools)
	}
	tool, _ := tools[0].(map[string]any)
	if tool["name"] != "call_solo" {
		t.Errorf("tool name = %v, want call_solo", tool["name"])
	}
	if tool["description"] != "custom: solo" {
		t.Errorf("description = %v, want the custom description", tool["description"])
	}
}

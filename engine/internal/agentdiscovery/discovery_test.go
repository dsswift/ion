package agentdiscovery

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseFrontmatter_AllFields(t *testing.T) {
	content := `---
name: researcher
parent: lead
description: Research specialist
model: claude-sonnet-4-6
tools: [Read, Grep, WebSearch]
priority: high
---
You are a research agent.`

	def, err := parseFrontmatter("/agents/researcher.md", content)
	if err != nil {
		t.Fatal(err)
	}
	if def.Name != "researcher" {
		t.Errorf("name = %q, want researcher", def.Name)
	}
	if def.Parent != "lead" {
		t.Errorf("parent = %q, want lead", def.Parent)
	}
	if def.Description != "Research specialist" {
		t.Errorf("description = %q", def.Description)
	}
	if def.Model != "claude-sonnet-4-6" {
		t.Errorf("model = %q", def.Model)
	}
	if len(def.Tools) != 3 || def.Tools[0] != "Read" {
		t.Errorf("tools = %v", def.Tools)
	}
	if def.Meta["priority"] != "high" {
		t.Errorf("meta[priority] = %q", def.Meta["priority"])
	}
	if def.SystemPrompt != "You are a research agent." {
		t.Errorf("system prompt = %q", def.SystemPrompt)
	}
}

func TestParseFrontmatter_Minimal(t *testing.T) {
	content := `---
description: simple agent
---
Do things.`

	def, err := parseFrontmatter("/agents/simple.md", content)
	if err != nil {
		t.Fatal(err)
	}
	if def.Name != "simple" {
		t.Errorf("name = %q, want simple (from path)", def.Name)
	}
	if def.Parent != "" {
		t.Errorf("parent should be empty, got %q", def.Parent)
	}
	if def.Description != "simple agent" {
		t.Errorf("description = %q", def.Description)
	}
}

func TestParseFrontmatter_NoFence(t *testing.T) {
	_, err := parseFrontmatter("/agents/bad.md", "no frontmatter here")
	if err == nil {
		t.Error("expected error for missing frontmatter")
	}
}

func TestParseFrontmatter_UnclosedFence(t *testing.T) {
	_, err := parseFrontmatter("/agents/bad.md", "---\nname: broken\nno closing fence")
	if err == nil {
		t.Error("expected error for unclosed fence")
	}
}

func TestParseList(t *testing.T) {
	tests := []struct {
		input string
		want  int
	}{
		{"[Read, Write, Bash]", 3},
		{"Read, Write", 2},
		{"[Read]", 1},
		{"", 0},
	}
	for _, tt := range tests {
		got := parseList(tt.input)
		if len(got) != tt.want {
			t.Errorf("parseList(%q) = %v, want len %d", tt.input, got, tt.want)
		}
	}
}

func TestWalkAgentFiles_Recursive(t *testing.T) {
	dir := t.TempDir()
	// Create nested structure
	sub := filepath.Join(dir, "team")
	os.MkdirAll(sub, 0o755)

	writeFile(t, filepath.Join(dir, "root.md"), minimalAgent("root"))
	writeFile(t, filepath.Join(sub, "child.md"), minimalAgent("child"))
	writeFile(t, filepath.Join(dir, "readme.txt"), "not an agent")

	paths, err := WalkAgentFiles(WalkOptions{
		ExtraDirs: []string{dir},
		Recursive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 2 {
		t.Errorf("got %d paths, want 2: %v", len(paths), paths)
	}
}

func TestWalkAgentFiles_NonRecursive(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "team")
	os.MkdirAll(sub, 0o755)

	writeFile(t, filepath.Join(dir, "root.md"), minimalAgent("root"))
	writeFile(t, filepath.Join(sub, "child.md"), minimalAgent("child"))

	paths, err := WalkAgentFiles(WalkOptions{
		ExtraDirs: []string{dir},
		Recursive: false,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 {
		t.Errorf("got %d paths, want 1 (root only): %v", len(paths), paths)
	}
}

func TestWalkAgentFiles_Dedup(t *testing.T) {
	// Project dir should win over user dir
	projectDir := t.TempDir()
	userDir := t.TempDir()

	writeFile(t, filepath.Join(projectDir, "agent.md"), "---\ndescription: project version\n---\nproject")
	writeFile(t, filepath.Join(userDir, "agent.md"), "---\ndescription: user version\n---\nuser")

	// Project dir listed first, so it wins
	paths, err := WalkAgentFiles(WalkOptions{
		ExtraDirs: []string{projectDir, userDir},
		Recursive: true,
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(paths) != 1 {
		t.Fatalf("got %d paths, want 1 (deduped): %v", len(paths), paths)
	}
	// Should be the project dir version
	if filepath.Dir(paths[0]) != projectDir {
		t.Errorf("expected project dir to win, got %s", paths[0])
	}
}

func TestBuildGraph_ParentChildren(t *testing.T) {
	agents := []*AgentDef{
		{Name: "lead", Path: "/a/lead.md", Meta: map[string]string{}},
		{Name: "coder", Path: "/a/coder.md", Parent: "lead", Meta: map[string]string{}},
		{Name: "reviewer", Path: "/a/reviewer.md", Parent: "lead", Meta: map[string]string{}},
	}
	g, err := BuildGraph(agents)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Roots) != 1 || g.Roots[0] != "lead" {
		t.Errorf("roots = %v, want [lead]", g.Roots)
	}
	children := g.Children["lead"]
	if len(children) != 2 {
		t.Errorf("lead children = %v, want [coder, reviewer]", children)
	}
}

func TestBuildGraph_CycleDetection(t *testing.T) {
	agents := []*AgentDef{
		{Name: "a", Path: "/a.md", Parent: "c", Meta: map[string]string{}},
		{Name: "b", Path: "/b.md", Parent: "a", Meta: map[string]string{}},
		{Name: "c", Path: "/c.md", Parent: "b", Meta: map[string]string{}},
	}
	_, err := BuildGraph(agents)
	if err == nil {
		t.Error("expected cycle error")
	}
	if err != nil && !contains(err.Error(), "cycle detected") {
		t.Errorf("error = %q, want cycle message", err.Error())
	}
}

func TestBuildGraph_MissingParent(t *testing.T) {
	agents := []*AgentDef{
		{Name: "orphan", Path: "/orphan.md", Parent: "nonexistent", Meta: map[string]string{}},
	}
	g, err := BuildGraph(agents)
	if err != nil {
		t.Fatal(err)
	}
	// orphan becomes root, parent cleared
	if len(g.Roots) != 1 || g.Roots[0] != "orphan" {
		t.Errorf("roots = %v, want [orphan]", g.Roots)
	}
	if g.Agents["orphan"].Parent != "" {
		t.Errorf("parent should be cleared, got %q", g.Agents["orphan"].Parent)
	}
	if g.Agents["orphan"].Meta["_warning"] == "" {
		t.Error("expected warning in meta for missing parent")
	}
}

func TestBuildGraph_MultipleRoots(t *testing.T) {
	agents := []*AgentDef{
		{Name: "alpha", Path: "/a.md", Meta: map[string]string{}},
		{Name: "beta", Path: "/b.md", Meta: map[string]string{}},
		{Name: "child", Path: "/c.md", Parent: "alpha", Meta: map[string]string{}},
	}
	g, err := BuildGraph(agents)
	if err != nil {
		t.Fatal(err)
	}
	if len(g.Roots) != 2 {
		t.Errorf("roots = %v, want [alpha, beta]", g.Roots)
	}
}

func TestDiscover_EndToEnd(t *testing.T) {
	dir := t.TempDir()
	sub := filepath.Join(dir, "team")
	os.MkdirAll(sub, 0o755)

	writeFile(t, filepath.Join(dir, "lead.md"), `---
description: Team lead
model: claude-opus-4-6
---
You coordinate the team.`)

	writeFile(t, filepath.Join(sub, "coder.md"), `---
description: Code writer
parent: lead
tools: [Read, Write, Edit, Bash]
---
You write code.`)

	writeFile(t, filepath.Join(sub, "reviewer.md"), `---
description: Code reviewer
parent: lead
tools: [Read, Grep]
---
You review code.`)

	g, err := Discover(WalkOptions{
		ExtraDirs: []string{dir},
		Recursive: true,
	})
	if err != nil {
		t.Fatal(err)
	}

	if len(g.Agents) != 3 {
		t.Fatalf("got %d agents, want 3", len(g.Agents))
	}
	if len(g.Roots) != 1 || g.Roots[0] != "lead" {
		t.Errorf("roots = %v, want [lead]", g.Roots)
	}
	children := g.Children["lead"]
	if len(children) != 2 {
		t.Errorf("lead children = %v, want [coder, reviewer]", children)
	}
	if g.Agents["lead"].Model != "claude-opus-4-6" {
		t.Errorf("lead model = %q", g.Agents["lead"].Model)
	}
	if len(g.Agents["coder"].Tools) != 4 {
		t.Errorf("coder tools = %v", g.Agents["coder"].Tools)
	}
}

func TestLoadAgent(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test-agent.md")
	writeFile(t, path, `---
name: custom-name
description: test
tools: Read, Write
---
System prompt here.`)

	def, err := LoadAgent(path)
	if err != nil {
		t.Fatal(err)
	}
	if def.Name != "custom-name" {
		t.Errorf("name = %q, want custom-name", def.Name)
	}
	if len(def.Tools) != 2 {
		t.Errorf("tools = %v", def.Tools)
	}
}

// helpers

func writeFile(t *testing.T, path, content string) {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
}

func minimalAgent(name string) string {
	return "---\nname: " + name + "\ndescription: test\n---\nPrompt for " + name
}

func contains(s, sub string) bool {
	return len(s) >= len(sub) && (s == sub || len(s) > 0 && containsStr(s, sub))
}

func containsStr(s, sub string) bool {
	for i := 0; i <= len(s)-len(sub); i++ {
		if s[i:i+len(sub)] == sub {
			return true
		}
	}
	return false
}

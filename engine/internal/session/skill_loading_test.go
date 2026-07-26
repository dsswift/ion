package session

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/tools"
)

// ---------------------------------------------------------------------------
// Helper: create an Ion-style skill file (markdown with frontmatter).
// ---------------------------------------------------------------------------

func writeIonSkill(t *testing.T, dir, filename, name, description, content string) string {
	t.Helper()
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	fp := filepath.Join(dir, filename)
	body := "---\nname: " + name + "\ndescription: " + description + "\n---\n" + content + "\n"
	if err := os.WriteFile(fp, []byte(body), 0o644); err != nil {
		t.Fatalf("write %s: %v", fp, err)
	}
	return fp
}

// writeClaudeSkill creates a Claude Code–style skill: subdir/SKILL.md.
func writeClaudeSkill(t *testing.T, rootDir, subdirName, description, whenToUse, content string) string {
	t.Helper()
	dir := filepath.Join(rootDir, subdirName)
	if err := os.MkdirAll(dir, 0o755); err != nil {
		t.Fatalf("mkdir %s: %v", dir, err)
	}
	fp := filepath.Join(dir, "SKILL.md")
	var fm strings.Builder
	fm.WriteString("---\n")
	fm.WriteString("name: should-be-overridden\n")
	if description != "" {
		fm.WriteString("description: " + description + "\n")
	}
	if whenToUse != "" {
		fm.WriteString("when_to_use: " + whenToUse + "\n")
	}
	fm.WriteString("---\n")
	fm.WriteString(content + "\n")
	if err := os.WriteFile(fp, []byte(fm.String()), 0o644); err != nil {
		t.Fatalf("write %s: %v", fp, err)
	}
	return fp
}

// ---------------------------------------------------------------------------
// 1. Ion skills are always loaded (unconditionally).
// ---------------------------------------------------------------------------

func TestSkillLoading_IonSkillsAlwaysLoaded(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	dir := t.TempDir()
	writeIonSkill(t, dir, "analyze.md", "analyze", "Run analysis", "Analyze the codebase.")
	writeIonSkill(t, dir, "deploy.md", "deploy", "Deploy things", "Deploy to production.")

	loaded, err := skills.LoadSkillDirectory(dir, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("expected 2 loaded skills, got %d", len(loaded))
	}
	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	// Verify both are in the global registry.
	if sk := skills.GetSkill("analyze"); sk == nil {
		t.Error("expected 'analyze' skill in registry")
	} else {
		if sk.Description != "Run analysis" {
			t.Errorf("analyze description = %q, want 'Run analysis'", sk.Description)
		}
		if sk.Content != "Analyze the codebase." {
			t.Errorf("analyze content = %q, want 'Analyze the codebase.'", sk.Content)
		}
	}
	if sk := skills.GetSkill("deploy"); sk == nil {
		t.Error("expected 'deploy' skill in registry")
	} else if sk.Description != "Deploy things" {
		t.Errorf("deploy description = %q, want 'Deploy things'", sk.Description)
	}

	names := skills.ListSkillNames()
	if len(names) != 2 {
		t.Errorf("expected 2 names, got %v", names)
	}
}

// ---------------------------------------------------------------------------
// 2. Claude-compat enabled: Claude skills are loaded.
// ---------------------------------------------------------------------------

func TestSkillLoading_ClaudeCompatEnabled(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	root := t.TempDir()
	writeClaudeSkill(t, root, "ilograph", "Diagram tool", "Use for diagrams", "Draw a diagram.")
	writeClaudeSkill(t, root, "security", "Security scanner", "", "Run security scan.")

	loaded, err := skills.LoadClaudeSkillsDirectory(root)
	if err != nil {
		t.Fatalf("LoadClaudeSkillsDirectory: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("expected 2 Claude skills, got %d", len(loaded))
	}
	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	// Verify the subdir name overrides frontmatter name.
	sk := skills.GetSkill("ilograph")
	if sk == nil {
		t.Fatal("expected 'ilograph' skill in registry")
	}
	if sk.Name != "ilograph" {
		t.Errorf("name = %q, want 'ilograph'", sk.Name)
	}
	if sk.Description != "Diagram tool" {
		t.Errorf("description = %q, want 'Diagram tool'", sk.Description)
	}
	if sk.WhenToUse != "Use for diagrams" {
		t.Errorf("WhenToUse = %q, want 'Use for diagrams'", sk.WhenToUse)
	}
	if sk.Content != "Draw a diagram." {
		t.Errorf("content = %q, want 'Draw a diagram.'", sk.Content)
	}

	if skills.GetSkill("security") == nil {
		t.Error("expected 'security' skill in registry")
	}
}

// ---------------------------------------------------------------------------
// 3. Claude-compat disabled: Claude skills are NOT loaded.
// ---------------------------------------------------------------------------

func TestSkillLoading_ClaudeCompatDisabled(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	// Create Claude-style skills on disk but do NOT call LoadClaudeSkillsDirectory.
	// This simulates the code path when config.ClaudeCompat == false.
	root := t.TempDir()
	writeClaudeSkill(t, root, "hidden-claude-skill", "Should not appear", "", "Secret.")

	// Only load Ion skills (empty dir).
	ionDir := t.TempDir()
	writeIonSkill(t, ionDir, "visible.md", "visible", "Ion skill", "Visible content.")

	loaded, err := skills.LoadSkillDirectory(ionDir, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	// Claude skill should NOT be in registry since we didn't load it.
	if sk := skills.GetSkill("hidden-claude-skill"); sk != nil {
		t.Error("Claude skill should NOT be in registry when ClaudeCompat is disabled")
	}

	// Ion skill should be present.
	if sk := skills.GetSkill("visible"); sk == nil {
		t.Error("expected 'visible' Ion skill in registry")
	}

	names := skills.ListSkillNames()
	if len(names) != 1 {
		t.Errorf("expected 1 skill, got %v", names)
	}
}

// ---------------------------------------------------------------------------
// 4. Registration precedence: last write wins.
// ---------------------------------------------------------------------------

func TestSkillLoading_IonSkillsOverrideClaudeSkills(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	// Simulate Ion loaded first, then Claude loaded second (last write wins).
	skills.RegisterSkill(&skills.Skill{
		Name:        "shared-name",
		Description: "From Ion",
		Content:     "Ion version.",
		Source:      "~/.ion/skills/shared-name.md",
	})
	skills.RegisterSkill(&skills.Skill{
		Name:        "shared-name",
		Description: "From Claude",
		Content:     "Claude version.",
		Source:      "~/.claude/skills/shared-name/SKILL.md",
	})

	sk := skills.GetSkill("shared-name")
	if sk == nil {
		t.Fatal("expected 'shared-name' in registry")
	}
	if sk.Description != "From Claude" {
		t.Errorf("expected Claude version (last write wins), got description=%q", sk.Description)
	}
	if sk.Content != "Claude version." {
		t.Errorf("expected Claude content (last write wins), got %q", sk.Content)
	}

	// Now test the reverse: Claude first, Ion second.
	skills.ClearSkillRegistry()
	skills.RegisterSkill(&skills.Skill{
		Name:        "shared-name",
		Description: "From Claude",
		Content:     "Claude version.",
	})
	skills.RegisterSkill(&skills.Skill{
		Name:        "shared-name",
		Description: "From Ion",
		Content:     "Ion version.",
	})

	sk = skills.GetSkill("shared-name")
	if sk.Description != "From Ion" {
		t.Errorf("expected Ion version (last write wins), got description=%q", sk.Description)
	}
}

// ---------------------------------------------------------------------------
// 5. Skill tool description reflects registry.
// ---------------------------------------------------------------------------

func TestSkillLoading_SkillToolReflectsRegistry(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	// Before any skills: no manifest.
	tools.RefreshSkillToolDescription()
	tool := tools.GetTool("Skill")
	if tool == nil {
		t.Fatal("Skill tool not registered")
	}
	if strings.Contains(tool.Description, "Available skills:") {
		t.Error("expected no manifest when no skills are registered")
	}

	// Register skills and refresh.
	skills.RegisterSkill(&skills.Skill{
		Name:        "analyzer",
		Description: "Analyzes code",
		Content:     "analyze content",
		WhenToUse:   "Use when analyzing code quality",
	})
	skills.RegisterSkill(&skills.Skill{
		Name:        "deployer",
		Description: "Deploys apps",
		Content:     "deploy content",
	})
	tools.RefreshSkillToolDescription()

	tool = tools.GetTool("Skill")
	if tool == nil {
		t.Fatal("Skill tool not registered after refresh")
	}
	if !strings.Contains(tool.Description, "Available skills:") {
		t.Error("expected 'Available skills:' header in description")
	}
	if !strings.Contains(tool.Description, "analyzer") {
		t.Error("expected 'analyzer' in description")
	}
	if !strings.Contains(tool.Description, "deployer") {
		t.Error("expected 'deployer' in description")
	}
	if !strings.Contains(tool.Description, "Use when analyzing code quality") {
		t.Error("expected when_to_use hint in description")
	}
}

// ---------------------------------------------------------------------------
// 6. Skill tool execution returns content.
// ---------------------------------------------------------------------------

func TestSkillLoading_SkillToolExecution(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{
		Name:        "greet",
		Description: "Greets the user",
		Content:     "Hello! How can I help you today?",
	})

	result, err := tools.ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "greet",
	}, "/tmp")
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error result: %s", result.Content)
	}
	if !strings.Contains(result.Content, "# Skill: greet") {
		t.Errorf("expected skill header, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Greets the user") {
		t.Errorf("expected description, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Hello! How can I help you today?") {
		t.Errorf("expected content, got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// 7. Empty / nonexistent directories → no error, no skills.
// ---------------------------------------------------------------------------

func TestSkillLoading_EmptyDirectoriesNoError(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	// Nonexistent directory.
	loaded, err := skills.LoadSkillDirectory("/nonexistent/path/to/skills", nil)
	if err != nil {
		t.Fatalf("expected nil error for nonexistent Ion dir, got: %v", err)
	}
	if loaded != nil {
		t.Errorf("expected nil skills for nonexistent Ion dir, got %d", len(loaded))
	}

	// Nonexistent Claude dir.
	claudeLoaded, err := skills.LoadClaudeSkillsDirectory("/nonexistent/claude/skills")
	if err != nil {
		t.Fatalf("expected nil error for nonexistent Claude dir, got: %v", err)
	}
	if claudeLoaded != nil {
		t.Errorf("expected nil skills for nonexistent Claude dir, got %d", len(claudeLoaded))
	}

	// Empty directory.
	emptyDir := t.TempDir()
	loaded, err = skills.LoadSkillDirectory(emptyDir, nil)
	if err != nil {
		t.Fatalf("expected nil error for empty dir, got: %v", err)
	}
	if len(loaded) != 0 {
		t.Errorf("expected 0 skills for empty dir, got %d", len(loaded))
	}

	// Empty Claude dir.
	claudeLoaded, err = skills.LoadClaudeSkillsDirectory(emptyDir)
	if err != nil {
		t.Fatalf("expected nil error for empty Claude dir, got: %v", err)
	}
	if len(claudeLoaded) != 0 {
		t.Errorf("expected 0 skills for empty Claude dir, got %d", len(claudeLoaded))
	}

	// Verify nothing was registered.
	if names := skills.ListSkillNames(); len(names) != 0 {
		t.Errorf("expected no skills registered, got %v", names)
	}
}

// ---------------------------------------------------------------------------
// 8. Filter support: LoadSkillDirectory respects filter function.
// ---------------------------------------------------------------------------

func TestSkillLoading_FilterSupport(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	dir := t.TempDir()
	writeIonSkill(t, dir, "keep-me.md", "keep-me", "Kept skill", "Keep content.")
	writeIonSkill(t, dir, "drop-me.md", "drop-me", "Dropped skill", "Drop content.")
	writeIonSkill(t, dir, "also-keep.md", "also-keep", "Also kept", "Also keep content.")

	// Filter: only accept files containing "keep" in the name.
	loaded, err := skills.LoadSkillDirectory(dir, func(path string) bool {
		return strings.Contains(filepath.Base(path), "keep")
	})
	if err != nil {
		t.Fatalf("LoadSkillDirectory with filter: %v", err)
	}
	if len(loaded) != 2 {
		t.Fatalf("expected 2 skills after filter, got %d", len(loaded))
	}

	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	if skills.GetSkill("keep-me") == nil {
		t.Error("expected 'keep-me' to pass filter")
	}
	if skills.GetSkill("also-keep") == nil {
		t.Error("expected 'also-keep' to pass filter")
	}
	if skills.GetSkill("drop-me") != nil {
		t.Error("'drop-me' should have been filtered out")
	}
}

// ---------------------------------------------------------------------------
// 9. StartSession: ClaudeCompat gating.
// ---------------------------------------------------------------------------

func TestSkillLoading_StartSessionClaudeCompatGating(t *testing.T) {
	// Start a session with ClaudeCompat=false (default). Because the real home
	// dir likely doesn't have ~/.claude/skills/ with files in CI, we verify
	// indirectly: clear the registry, start a session, and confirm no Claude
	// skills appeared. Then start with ClaudeCompat=true and verify the path
	// was attempted (still no files in CI, but the gating logic differs).

	t.Run("default_config_skips_claude_skills", func(t *testing.T) {
		skills.ClearSkillRegistry()
		defer skills.ClearSkillRegistry()

		mb := newMockBackend()
		mgr := NewManager(mb)

		cfg := defaultConfig()
		// ClaudeCompat is false by default (zero value).
		if cfg.ClaudeCompat {
			t.Fatal("defaultConfig() should have ClaudeCompat=false")
		}

		_, err := mgr.StartSession("test-no-claude", cfg)
		if err != nil {
			t.Fatalf("StartSession: %v", err)
		}

		// With ClaudeCompat=false, no Claude skills should be loaded.
		// (Ion skills from the real home dir may or may not exist.)
		for _, name := range skills.ListSkillNames() {
			sk := skills.GetSkill(name)
			if sk == nil {
				continue
			}
			if strings.Contains(sk.Source, ".claude/skills/") {
				t.Errorf("found Claude skill %q in registry with ClaudeCompat=false", name)
			}
		}
	})

	t.Run("claude_compat_enabled_attempts_loading", func(t *testing.T) {
		skills.ClearSkillRegistry()
		defer skills.ClearSkillRegistry()

		mb := newMockBackend()
		mgr := NewManager(mb)

		cfg := defaultConfig()
		cfg.ClaudeCompat = true

		_, err := mgr.StartSession("test-with-claude", cfg)
		if err != nil {
			t.Fatalf("StartSession: %v", err)
		}

		// We can't assert specific Claude skills exist (depends on CI env),
		// but the session should start without error. The ClaudeCompat code
		// path was exercised. The important thing is it doesn't panic or
		// error when the directory is missing.
	})
}

// ---------------------------------------------------------------------------
// 10. DisableModelInvocation: skill is in registry but tool refuses execution.
// ---------------------------------------------------------------------------

func TestSkillLoading_DisableModelInvocation(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	// Register a normal skill and a disabled one.
	skills.RegisterSkill(&skills.Skill{
		Name:        "normal-skill",
		Description: "Normal skill",
		Content:     "Normal content.",
	})
	skills.RegisterSkill(&skills.Skill{
		Name:                   "restricted-skill",
		Description:            "Restricted skill",
		Content:                "Secret instructions.",
		DisableModelInvocation: true,
	})

	// Both should be in the registry.
	if skills.GetSkill("normal-skill") == nil {
		t.Fatal("expected 'normal-skill' in registry")
	}
	if skills.GetSkill("restricted-skill") == nil {
		t.Fatal("expected 'restricted-skill' in registry")
	}

	// Normal skill should be executable.
	result, err := tools.ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "normal-skill",
	}, "/tmp")
	if err != nil {
		t.Fatalf("ExecuteTool normal: %v", err)
	}
	if result.IsError {
		t.Errorf("normal skill should not error: %s", result.Content)
	}

	// Restricted skill should be blocked.
	result, err = tools.ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "restricted-skill",
	}, "/tmp")
	if err != nil {
		t.Fatalf("ExecuteTool restricted: %v", err)
	}
	if !result.IsError {
		t.Error("expected error for restricted skill")
	}
	if !strings.Contains(result.Content, "cannot be invoked by the model") {
		t.Errorf("expected invocation-blocked message, got %q", result.Content)
	}

	// Manifest should omit the restricted skill.
	tools.RefreshSkillToolDescription()
	tool := tools.GetTool("Skill")
	if tool == nil {
		t.Fatal("Skill tool not registered")
	}
	if !strings.Contains(tool.Description, "normal-skill") {
		t.Error("expected 'normal-skill' in manifest")
	}
	if strings.Contains(tool.Description, "restricted-skill") {
		t.Error("restricted-skill should NOT appear in manifest")
	}
}

// ---------------------------------------------------------------------------
// Bonus: Ion skill loaded from disk ends up executable via Skill tool.
// ---------------------------------------------------------------------------

func TestSkillLoading_EndToEndIonSkillViaTool(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	dir := t.TempDir()
	writeIonSkill(t, dir, "code-review.md", "code-review",
		"Reviews code for quality issues",
		"Review the code and identify bugs, style issues, and improvement opportunities.")

	loaded, err := skills.LoadSkillDirectory(dir, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	// Refresh the Skill tool description so it reflects the loaded skills.
	tools.RefreshSkillToolDescription()

	// Verify the tool description includes the skill.
	tool := tools.GetTool("Skill")
	if tool == nil {
		t.Fatal("Skill tool not registered")
	}
	if !strings.Contains(tool.Description, "code-review") {
		t.Errorf("expected 'code-review' in tool description, got:\n%s", tool.Description)
	}

	// Execute the skill via the tool.
	result, err := tools.ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "code-review",
		"args":  "main.go",
	}, "/tmp")
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "# Skill: code-review") {
		t.Error("expected skill header in output")
	}
	if !strings.Contains(result.Content, "Reviews code for quality issues") {
		t.Error("expected description in output")
	}
	if !strings.Contains(result.Content, "Arguments: main.go") {
		t.Error("expected arguments in output")
	}
	if !strings.Contains(result.Content, "Review the code and identify bugs") {
		t.Error("expected skill content in output")
	}
}

// ---------------------------------------------------------------------------
// Bonus: Claude skill loaded from disk with when_to_use hint.
// ---------------------------------------------------------------------------

func TestSkillLoading_EndToEndClaudeSkillViaTool(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	root := t.TempDir()
	writeClaudeSkill(t, root, "terraform", "Terraform IaC skill",
		"Use when working with Terraform or infrastructure as code",
		"Apply best practices for Terraform modules and state management.")

	loaded, err := skills.LoadClaudeSkillsDirectory(root)
	if err != nil {
		t.Fatalf("LoadClaudeSkillsDirectory: %v", err)
	}
	for _, sk := range loaded {
		skills.RegisterSkill(sk)
	}

	tools.RefreshSkillToolDescription()

	// Verify the tool description includes the skill with its when_to_use.
	tool := tools.GetTool("Skill")
	if tool == nil {
		t.Fatal("Skill tool not registered")
	}
	if !strings.Contains(tool.Description, "terraform") {
		t.Errorf("expected 'terraform' in tool description, got:\n%s", tool.Description)
	}
	if !strings.Contains(tool.Description, "Use when working with Terraform") {
		t.Errorf("expected when_to_use hint in description, got:\n%s", tool.Description)
	}

	// Execute it.
	result, err := tools.ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "terraform",
	}, "/tmp")
	if err != nil {
		t.Fatalf("ExecuteTool: %v", err)
	}
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "# Skill: terraform") {
		t.Error("expected skill header")
	}
	if !strings.Contains(result.Content, "Apply best practices for Terraform") {
		t.Error("expected skill content")
	}
}

// ---------------------------------------------------------------------------
// Bonus: non-.md files are ignored by LoadSkillDirectory.
// ---------------------------------------------------------------------------

func TestSkillLoading_NonMarkdownFilesIgnored(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	dir := t.TempDir()
	writeIonSkill(t, dir, "valid.md", "valid", "Valid skill", "Valid.")
	// Write non-markdown files that should be ignored.
	os.WriteFile(filepath.Join(dir, "readme.txt"), []byte("not a skill"), 0o644)
	os.WriteFile(filepath.Join(dir, "config.json"), []byte(`{"key":"val"}`), 0o644)
	os.WriteFile(filepath.Join(dir, "script.sh"), []byte("#!/bin/bash"), 0o644)

	loaded, err := skills.LoadSkillDirectory(dir, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(loaded) != 1 {
		t.Errorf("expected 1 skill (only .md), got %d", len(loaded))
	}
	if loaded[0].Name != "valid" {
		t.Errorf("expected skill name 'valid', got %q", loaded[0].Name)
	}
}

// ---------------------------------------------------------------------------
// Bonus: subdirs without SKILL.md are skipped by LoadClaudeSkillsDirectory.
// ---------------------------------------------------------------------------

func TestSkillLoading_ClaudeSkipsDirsWithoutSkillMd(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	root := t.TempDir()

	// Has SKILL.md → loaded.
	writeClaudeSkill(t, root, "present", "Present skill", "", "Present content.")

	// Has README.md but no SKILL.md → skipped.
	noSkillDir := filepath.Join(root, "absent")
	os.MkdirAll(noSkillDir, 0o755)
	os.WriteFile(filepath.Join(noSkillDir, "README.md"), []byte("Not a skill"), 0o644)

	// Empty subdir → skipped.
	os.MkdirAll(filepath.Join(root, "empty"), 0o755)

	loaded, err := skills.LoadClaudeSkillsDirectory(root)
	if err != nil {
		t.Fatalf("LoadClaudeSkillsDirectory: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(loaded))
	}
	if loaded[0].Name != "present" {
		t.Errorf("expected name 'present', got %q", loaded[0].Name)
	}
}

// ---------------------------------------------------------------------------
// Session-scoped skill registry.
//
// The registry was process-global: a project-scoped skill loaded from
// <workingDir>/.ion/skills stayed registered after its session ended and was
// advertised to every other session. These tests pin the isolation that
// replaces it. See internal/skills/skills_session.go.
// ---------------------------------------------------------------------------

// TestSessionSkills_ProjectSkillDoesNotLeakToOtherSession is the regression
// test for the cross-session leak. Session A loads a project skill; session B
// (a different project) must not see it in its manifest.
//
// Revert RegisterSkillFor to RegisterSkill in start_session.go and this fails:
// B's manifest picks up A's skill from the global registry.
func TestSessionSkills_ProjectSkillDoesNotLeakToOtherSession(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	defer skills.ClearSkillsFor("session-A")
	defer skills.ClearSkillsFor("session-B")

	projectA := t.TempDir()
	writeIonSkill(t, filepath.Join(projectA, ".ion", "skills"),
		"graphify.md", "graphify", "Query the knowledge graph", "graphify body")

	// Session A loads project A's skills.
	loaded, err := skills.LoadSkillDirectory(filepath.Join(projectA, ".ion", "skills"), nil)
	if err != nil {
		t.Fatalf("load project A skills: %v", err)
	}
	if len(loaded) != 1 {
		t.Fatalf("expected 1 skill in project A, got %d", len(loaded))
	}
	for _, sk := range loaded {
		skills.RegisterSkillFor("session-A", sk)
	}

	// Session B is a different project with no skills of its own.
	if got := skills.GetSkillFor("session-B", "graphify"); got != nil {
		t.Error("project skill from session A leaked into session B")
	}

	// And session A still resolves it.
	if got := skills.GetSkillFor("session-A", "graphify"); got == nil {
		t.Error("session A cannot resolve its own project skill")
	}

	// The system-prompt section is the surface the model actually sees.
	if section := tools.BuildSkillSystemPromptSectionFor("session-B"); strings.Contains(section, "graphify") {
		t.Errorf("session B's skill listing advertises session A's project skill:\n%s", section)
	}
	if section := tools.BuildSkillSystemPromptSectionFor("session-A"); !strings.Contains(section, "graphify") {
		t.Errorf("session A's skill listing omits its own project skill:\n%s", section)
	}
}

// TestSessionSkills_SameNameResolvesIndependently verifies two projects that
// each ship a same-named skill resolve to their own copy. Under the global
// registry the last session to start won for every session.
func TestSessionSkills_SameNameResolvesIndependently(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	defer skills.ClearSkillsFor("sess-1")
	defer skills.ClearSkillsFor("sess-2")

	p1 := t.TempDir()
	writeIonSkill(t, filepath.Join(p1, ".ion", "skills"),
		"deploy.md", "deploy", "Project one deploy", "ONE")
	p2 := t.TempDir()
	writeIonSkill(t, filepath.Join(p2, ".ion", "skills"),
		"deploy.md", "deploy", "Project two deploy", "TWO")

	for _, tc := range []struct{ key, dir string }{
		{"sess-1", filepath.Join(p1, ".ion", "skills")},
		{"sess-2", filepath.Join(p2, ".ion", "skills")},
	} {
		loaded, err := skills.LoadSkillDirectory(tc.dir, nil)
		if err != nil {
			t.Fatalf("load %s: %v", tc.dir, err)
		}
		for _, sk := range loaded {
			skills.RegisterSkillFor(tc.key, sk)
		}
	}

	one := skills.GetSkillFor("sess-1", "deploy")
	two := skills.GetSkillFor("sess-2", "deploy")
	if one == nil || two == nil {
		t.Fatal("both sessions must resolve their own deploy skill")
	}
	if !strings.Contains(one.Content, "ONE") {
		t.Errorf("sess-1 resolved the wrong deploy skill: %q", one.Content)
	}
	if !strings.Contains(two.Content, "TWO") {
		t.Errorf("sess-2 resolved the wrong deploy skill: %q", two.Content)
	}
}

// TestSessionSkills_ClearEvictsOnlyThatSession verifies teardown is scoped.
// A stopped session's skills go away; a concurrently-live session keeps its
// own — including a user-scoped skill of the same name, which is why user
// skills are copied per session rather than shared via fallback.
func TestSessionSkills_ClearEvictsOnlyThatSession(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()
	defer skills.ClearSkillsFor("stays")

	userDir := t.TempDir()
	writeIonSkill(t, userDir, "caveman.md", "caveman", "User-scoped skill", "user body")
	loaded, err := skills.LoadSkillDirectory(userDir, nil)
	if err != nil {
		t.Fatalf("load user skills: %v", err)
	}

	// Both sessions register the same user skill (the per-session copy model).
	for _, key := range []string{"goes-away", "stays"} {
		for _, sk := range loaded {
			skills.RegisterSkillFor(key, sk)
		}
	}

	evicted := skills.ClearSkillsFor("goes-away")
	if evicted != 1 {
		t.Errorf("expected 1 evicted entry, got %d", evicted)
	}
	if got := skills.GetSkillFor("stays", "caveman"); got == nil {
		t.Error("clearing one session stripped a live session's user skill")
	}
}

// TestSessionSkills_ZeroKeyFallsBackToGlobal pins the additive contract: a
// caller with no session key (external SDK consumer, API-backend path) still
// resolves against the global registry, so existing behaviour is unchanged.
func TestSessionSkills_ZeroKeyFallsBackToGlobal(t *testing.T) {
	skills.ClearSkillRegistry()
	defer skills.ClearSkillRegistry()

	skills.RegisterSkill(&skills.Skill{Name: "global-only", Description: "Registered globally"})

	if got := skills.GetSkillFor("", "global-only"); got == nil {
		t.Error("empty key must resolve against the global registry")
	}
	names := skills.ListSkillNamesFor("")
	if len(names) != 1 || names[0] != "global-only" {
		t.Errorf("expected [global-only] from the global registry, got %v", names)
	}
	if section := tools.BuildSkillSystemPromptSectionFor(""); !strings.Contains(section, "global-only") {
		t.Errorf("empty-key skill listing must read the global registry:\n%s", section)
	}
}

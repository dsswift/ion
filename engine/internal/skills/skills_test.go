package skills

import (
	"os"
	"path/filepath"
	"testing"
)

func TestLoadSkill(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "test-skill.md")
	content := `---
name: Test Skill
description: A test skill for validation
author: test
---

This is the skill content.

It has multiple lines.
`
	os.WriteFile(fp, []byte(content), 0o644)

	skill, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	if skill.Name != "Test Skill" {
		t.Errorf("Name = %q, want 'Test Skill'", skill.Name)
	}
	if skill.Description != "A test skill for validation" {
		t.Errorf("Description = %q, want 'A test skill for validation'", skill.Description)
	}
	if skill.Metadata["author"] != "test" {
		t.Errorf("Metadata[author] = %q, want 'test'", skill.Metadata["author"])
	}
	if skill.Content == "" {
		t.Error("expected non-empty content")
	}
}

func TestLoadSkillNoFrontmatter(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "plain.md")
	os.WriteFile(fp, []byte("Just plain content."), 0o644)

	skill, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	if skill.Name != "plain" {
		t.Errorf("Name = %q, want 'plain'", skill.Name)
	}
	if skill.Content != "Just plain content." {
		t.Errorf("Content = %q", skill.Content)
	}
}

func TestLoadSkillDirectory(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "a.md"), []byte("---\nname: A\n---\nContent A"), 0o644)
	os.WriteFile(filepath.Join(dir, "b.md"), []byte("---\nname: B\n---\nContent B"), 0o644)
	os.WriteFile(filepath.Join(dir, "skip.txt"), []byte("not a skill"), 0o644)

	skills, err := LoadSkillDirectory(dir, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 2 {
		t.Errorf("expected 2 skills, got %d", len(skills))
	}
}

func TestLoadSkillDirectoryWithFilter(t *testing.T) {
	dir := t.TempDir()
	os.WriteFile(filepath.Join(dir, "keep.md"), []byte("keep"), 0o644)
	os.WriteFile(filepath.Join(dir, "drop.md"), []byte("drop"), 0o644)

	skills, err := LoadSkillDirectory(dir, func(p string) bool {
		return filepath.Base(p) == "keep.md"
	})
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 1 {
		t.Errorf("expected 1 skill, got %d", len(skills))
	}
}

func TestLoadSkillDirectoryMissing(t *testing.T) {
	skills, err := LoadSkillDirectory("/nonexistent/path", nil)
	if err != nil {
		t.Fatalf("expected nil error for missing dir, got: %v", err)
	}
	if skills != nil {
		t.Errorf("expected nil skills for missing dir")
	}
}

func TestSkillPaths(t *testing.T) {
	tests := []struct {
		name string
		fn   func() SkillPaths
	}{
		{"Ion", IonSkillPaths},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			paths := tt.fn()
			if paths.User == "" {
				t.Error("expected non-empty User path")
			}
			if paths.Project == "" {
				t.Error("expected non-empty Project path")
			}
			if paths.ClaudeUser == "" {
				t.Error("expected non-empty ClaudeUser path")
			}
		})
	}
}

// TestLoadSkillWhenToUse verifies that the when_to_use frontmatter key is
// parsed into WhenToUse and exposed on the Skill struct.
func TestLoadSkillWhenToUse(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "diagrammer.md")
	content := `---
name: diagrammer
description: Creates diagrams
when_to_use: Use when the user asks for a diagram or architecture chart
---
Draw a diagram.
`
	os.WriteFile(fp, []byte(content), 0o644)

	skill, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	want := "Use when the user asks for a diagram or architecture chart"
	if skill.WhenToUse != want {
		t.Errorf("WhenToUse = %q, want %q", skill.WhenToUse, want)
	}
	if skill.DisableModelInvocation {
		t.Error("expected DisableModelInvocation=false by default")
	}
}

// TestLoadSkillDisableModelInvocation verifies that disable-model-invocation:
// true (case-insensitive) is parsed correctly.
func TestLoadSkillDisableModelInvocation(t *testing.T) {
	tests := []struct {
		value    string
		wantDisabled bool
	}{
		{"true", true},
		{"True", true},
		{"TRUE", true},
		{"false", false},
		{"yes", false},
		{"", false},
	}
	for _, tc := range tests {
		t.Run(tc.value, func(t *testing.T) {
			dir := t.TempDir()
			fp := filepath.Join(dir, "sk.md")
			var fm string
			if tc.value != "" {
				fm = "---\nname: sk\ndisable-model-invocation: " + tc.value + "\n---\ncontent"
			} else {
				fm = "---\nname: sk\n---\ncontent"
			}
			os.WriteFile(fp, []byte(fm), 0o644)
			skill, err := LoadSkill(fp)
			if err != nil {
				t.Fatalf("LoadSkill: %v", err)
			}
			if skill.DisableModelInvocation != tc.wantDisabled {
				t.Errorf("DisableModelInvocation = %v, want %v", skill.DisableModelInvocation, tc.wantDisabled)
			}
		})
	}
}

// TestLoadClaudeSkillsDirectory verifies directory-per-skill loading:
// subdirs with a SKILL.md are loaded; subdirs without are skipped; plain
// files are skipped; the subdir name overrides any frontmatter `name`.
func TestLoadClaudeSkillsDirectory(t *testing.T) {
	root := t.TempDir()

	// foo/SKILL.md — should be loaded, name = "foo"
	fooDir := filepath.Join(root, "foo")
	os.Mkdir(fooDir, 0o755)
	fooContent := `---
name: should-be-overridden
description: Foo skill
when_to_use: Use for foo things
---
Foo content.
`
	os.WriteFile(filepath.Join(fooDir, "SKILL.md"), []byte(fooContent), 0o644)

	// bar/README.md — no SKILL.md, should be skipped
	barDir := filepath.Join(root, "bar")
	os.Mkdir(barDir, 0o755)
	os.WriteFile(filepath.Join(barDir, "README.md"), []byte("not a skill"), 0o644)

	// baz — plain file, not a dir, should be skipped
	os.WriteFile(filepath.Join(root, "baz.md"), []byte("not a skill"), 0o644)

	skills, err := LoadClaudeSkillsDirectory(root)
	if err != nil {
		t.Fatalf("LoadClaudeSkillsDirectory: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(skills))
	}
	sk := skills[0]
	// Directory name must override the frontmatter name.
	if sk.Name != "foo" {
		t.Errorf("Name = %q, want 'foo'", sk.Name)
	}
	if sk.Description != "Foo skill" {
		t.Errorf("Description = %q, want 'Foo skill'", sk.Description)
	}
	if sk.WhenToUse != "Use for foo things" {
		t.Errorf("WhenToUse = %q", sk.WhenToUse)
	}
	if sk.Content != "Foo content." {
		t.Errorf("Content = %q, want 'Foo content.'", sk.Content)
	}
}

// TestLoadClaudeSkillsDirectoryMissing verifies that a missing root directory
// returns nil, nil (not an error).
func TestLoadClaudeSkillsDirectoryMissing(t *testing.T) {
	skills, err := LoadClaudeSkillsDirectory("/nonexistent/path")
	if err != nil {
		t.Fatalf("expected nil error for missing dir, got: %v", err)
	}
	if skills != nil {
		t.Errorf("expected nil skills for missing dir")
	}
}


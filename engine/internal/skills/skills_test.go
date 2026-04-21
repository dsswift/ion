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
		})
	}
}

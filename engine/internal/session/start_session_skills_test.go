package session

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/types"
)

// TestStartSession_LoadsProjectSkillsFromWorkingDirectory pins the fix for the
// project skill root: skills in {workingDir}/.ion/skills/<name>/SKILL.md must
// register at session start. Before the fix the project root was the literal
// relative path "./.ion/skills" — resolved against the daemon's cwd, so a
// session's project skills never loaded.
func TestStartSession_LoadsProjectSkillsFromWorkingDirectory(t *testing.T) {
	skills.ClearSkillRegistry()
	t.Cleanup(skills.ClearSkillRegistry)
	// Isolate HOME so the real ~/.ion/skills does not leak into the registry.
	t.Setenv("HOME", t.TempDir())

	wd := t.TempDir()
	skillDir := filepath.Join(wd, ".ion", "skills", "proj-skill")
	if err := os.MkdirAll(skillDir, 0o755); err != nil {
		t.Fatal(err)
	}
	content := "---\ndescription: project-local test skill\n---\n\nDo the project thing."
	if err := os.WriteFile(filepath.Join(skillDir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}

	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("skill-wd", types.EngineConfig{ProfileID: "test", WorkingDirectory: wd}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}

	sk := skills.GetSkill("proj-skill")
	if sk == nil {
		t.Fatalf("project skill not registered; registry = %v", skills.ListSkillNames())
	}
	if sk.Description != "project-local test skill" {
		t.Errorf("Description = %q", sk.Description)
	}
}

// TestStartSession_EmptyWorkingDirectorySkipsProjectSkills pins the guard: an
// empty working directory must not probe a relative "./.ion/skills" path.
func TestStartSession_EmptyWorkingDirectorySkipsProjectSkills(t *testing.T) {
	skills.ClearSkillRegistry()
	t.Cleanup(skills.ClearSkillRegistry)
	t.Setenv("HOME", t.TempDir())

	mb := newMockBackend()
	mgr := NewManager(mb)
	if _, err := mgr.StartSession("skill-nowd", types.EngineConfig{ProfileID: "test"}); err != nil {
		t.Fatalf("StartSession: %v", err)
	}
	if names := skills.ListSkillNames(); len(names) != 0 {
		t.Errorf("expected no skills registered, got %v", names)
	}
}

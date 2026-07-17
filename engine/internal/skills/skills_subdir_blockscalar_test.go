package skills

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// ---------------------------------------------------------------------------
// Subdirectory loading in LoadSkillDirectory
// ---------------------------------------------------------------------------

func TestLoadSkillDirectory_SubdirectoryFormat(t *testing.T) {
	root := t.TempDir()

	// caveman/SKILL.md — the industry-standard subdirectory layout.
	subDir := filepath.Join(root, "caveman")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	content := "---\nname: should-be-overridden\ndescription: Caveman skill\n---\nTalk like caveman.\n"
	if err := os.WriteFile(filepath.Join(subDir, "SKILL.md"), []byte(content), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}

	skills, err := LoadSkillDirectory(root, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("expected 1 skill, got %d", len(skills))
	}
	sk := skills[0]
	// Directory name must win over frontmatter name.
	if sk.Name != "caveman" {
		t.Errorf("Name = %q, want %q", sk.Name, "caveman")
	}
	if sk.Description != "Caveman skill" {
		t.Errorf("Description = %q, want %q", sk.Description, "Caveman skill")
	}
	if sk.Content != "Talk like caveman." {
		t.Errorf("Content = %q, want %q", sk.Content, "Talk like caveman.")
	}
	if !strings.HasSuffix(sk.Source, "SKILL.md") {
		t.Errorf("Source should end with SKILL.md, got %q", sk.Source)
	}
}

func TestLoadSkillDirectory_MixedFlatAndSubdir(t *testing.T) {
	root := t.TempDir()

	// Flat file.
	if err := os.WriteFile(filepath.Join(root, "foo.md"), []byte("---\nname: foo\n---\nFoo content."), 0o644); err != nil {
		t.Fatalf("write foo.md: %v", err)
	}

	// Subdirectory skill.
	barDir := filepath.Join(root, "bar")
	if err := os.MkdirAll(barDir, 0o755); err != nil {
		t.Fatalf("mkdir bar: %v", err)
	}
	if err := os.WriteFile(filepath.Join(barDir, "SKILL.md"), []byte("---\ndescription: Bar skill\n---\nBar content."), 0o644); err != nil {
		t.Fatalf("write bar/SKILL.md: %v", err)
	}

	skills, err := LoadSkillDirectory(root, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 2 {
		t.Fatalf("expected 2 skills, got %d", len(skills))
	}

	names := make(map[string]bool)
	for _, sk := range skills {
		names[sk.Name] = true
	}
	if !names["foo"] {
		t.Error("expected skill 'foo'")
	}
	if !names["bar"] {
		t.Error("expected skill 'bar'")
	}
}

func TestLoadSkillDirectory_SubdirWithoutSkillMdSkipped(t *testing.T) {
	root := t.TempDir()

	// Subdirectory with only README.md — no SKILL.md.
	noSkill := filepath.Join(root, "noskill")
	if err := os.MkdirAll(noSkill, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	if err := os.WriteFile(filepath.Join(noSkill, "README.md"), []byte("not a skill"), 0o644); err != nil {
		t.Fatalf("write README.md: %v", err)
	}

	// Empty subdirectory.
	if err := os.MkdirAll(filepath.Join(root, "empty"), 0o755); err != nil {
		t.Fatalf("mkdir empty: %v", err)
	}

	skills, err := LoadSkillDirectory(root, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 0 {
		t.Errorf("expected 0 skills, got %d: %+v", len(skills), skills)
	}
}

func TestLoadSkillDirectory_SubdirMalformedSkillMdSkipped(t *testing.T) {
	if os.Getuid() == 0 {
		t.Skip("running as root: file permission restrictions do not apply, chmod-based test cannot exercise the unreadable-file path")
	}
	root := t.TempDir()

	// Subdirectory with an unreadable SKILL.md.
	subDir := filepath.Join(root, "broken")
	if err := os.MkdirAll(subDir, 0o755); err != nil {
		t.Fatalf("mkdir: %v", err)
	}
	skillFile := filepath.Join(subDir, "SKILL.md")
	if err := os.WriteFile(skillFile, []byte("some content"), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}
	// Make it unreadable.
	if err := os.Chmod(skillFile, 0o000); err != nil {
		t.Fatalf("chmod: %v", err)
	}
	t.Cleanup(func() { _ = os.Chmod(skillFile, 0o644) })

	skills, err := LoadSkillDirectory(root, nil)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	// Unreadable SKILL.md is silently skipped.
	if len(skills) != 0 {
		t.Errorf("expected 0 skills (unreadable skipped), got %d", len(skills))
	}
}

func TestLoadSkillDirectory_FilterAppliesToSubdirSkillMd(t *testing.T) {
	root := t.TempDir()

	// Two subdirectory skills; filter accepts only "keep".
	for _, name := range []string{"keep", "drop"} {
		d := filepath.Join(root, name)
		if err := os.MkdirAll(d, 0o755); err != nil {
			t.Fatalf("mkdir %s: %v", name, err)
		}
		body := "---\ndescription: " + name + "\n---\n" + name + " content."
		if err := os.WriteFile(filepath.Join(d, "SKILL.md"), []byte(body), 0o644); err != nil {
			t.Fatalf("write %s/SKILL.md: %v", name, err)
		}
	}

	filter := func(path string) bool {
		// Filter receives the full SKILL.md path; accept only those whose
		// parent directory is named "keep".
		return filepath.Base(filepath.Dir(path)) == "keep"
	}

	skills, err := LoadSkillDirectory(root, filter)
	if err != nil {
		t.Fatalf("LoadSkillDirectory: %v", err)
	}
	if len(skills) != 1 {
		t.Fatalf("expected 1 skill after filter, got %d", len(skills))
	}
	if skills[0].Name != "keep" {
		t.Errorf("Name = %q, want %q", skills[0].Name, "keep")
	}
}

// ---------------------------------------------------------------------------
// YAML block scalar frontmatter
// ---------------------------------------------------------------------------

func TestLoadSkill_BlockScalarFolded(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "sk.md")
	content := "---\n" +
		"name: myskill\n" +
		"description: >\n" +
		"  First line of description.\n" +
		"  Second line of description.\n" +
		"when_to_use: use it\n" +
		"---\n" +
		"Skill body.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	// Folded: lines joined with a single space, no stray newlines.
	wantDesc := "First line of description. Second line of description."
	if sk.Description != wantDesc {
		t.Errorf("Description = %q, want %q", sk.Description, wantDesc)
	}
	// Key after the block scalar must parse normally.
	if sk.WhenToUse != "use it" {
		t.Errorf("WhenToUse = %q, want %q", sk.WhenToUse, "use it")
	}
	if sk.Name != "myskill" {
		t.Errorf("Name = %q, want %q", sk.Name, "myskill")
	}
	if sk.Content != "Skill body." {
		t.Errorf("Content = %q, want %q", sk.Content, "Skill body.")
	}
}

func TestLoadSkill_BlockScalarLiteral(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "sk.md")
	content := "---\n" +
		"name: literalskill\n" +
		"description: |\n" +
		"  Line one.\n" +
		"  Line two.\n" +
		"---\n" +
		"Body.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	// Literal: newlines preserved between lines.
	wantDesc := "Line one.\nLine two."
	if sk.Description != wantDesc {
		t.Errorf("Description = %q, want %q", sk.Description, wantDesc)
	}
	if sk.Content != "Body." {
		t.Errorf("Content = %q, want %q", sk.Content, "Body.")
	}
}

func TestLoadSkill_BlockScalarWhenToUse(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "sk.md")
	content := "---\n" +
		"name: sk\n" +
		"when_to_use: >\n" +
		"  Use when the user asks for brevity.\n" +
		"  Also use when tokens are tight.\n" +
		"---\n" +
		"Body.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	want := "Use when the user asks for brevity. Also use when tokens are tight."
	if sk.WhenToUse != want {
		t.Errorf("WhenToUse = %q, want %q", sk.WhenToUse, want)
	}
}

func TestLoadSkill_BlockScalarNoBody(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "sk.md")
	// Block scalar indicator immediately followed by the closing ---.
	content := "---\n" +
		"name: sk\n" +
		"description: >\n" +
		"---\n" +
		"Body.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	// No continuation lines → empty string, not ">" or panic.
	if sk.Description != "" {
		t.Errorf("Description = %q, want empty string", sk.Description)
	}
	if sk.Content != "Body." {
		t.Errorf("Content = %q, want %q", sk.Content, "Body.")
	}
}

func TestLoadSkill_BlockScalarTrailingSpaceOnIndicatorLine(t *testing.T) {
	dir := t.TempDir()
	fp := filepath.Join(dir, "sk.md")
	// Trailing spaces after > — still detected as a block scalar.
	content := "---\nname: sk\ndescription: >  \n  Hello world.\n---\nBody.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}
	if sk.Description != "Hello world." {
		t.Errorf("Description = %q, want %q", sk.Description, "Hello world.")
	}
}

func TestLoadSkill_CavemanRealFormat(t *testing.T) {
	// This is a regression anchor: matches the real caveman SKILL.md frontmatter
	// shape exactly. If the real-world format ever breaks, this catches it.
	dir := t.TempDir()
	fp := filepath.Join(dir, "SKILL.md")
	content := "---\n" +
		"name: caveman\n" +
		"description: >\n" +
		"  Ultra-compressed communication mode. Cuts output tokens 65% (measured) by speaking like caveman\n" +
		"  while keeping full technical accuracy. Supports intensity levels: lite, full (default), ultra,\n" +
		"  wenyan-lite, wenyan-full, wenyan-ultra.\n" +
		"  Use when user says \"caveman mode\", \"talk like caveman\", \"use caveman\", \"less tokens\",\n" +
		"  \"be brief\", or invokes /caveman. Also auto-triggers when token efficiency is requested.\n" +
		"---\n" +
		"\n" +
		"Respond terse like smart caveman. All technical substance stay. Only fluff die.\n"
	if err := os.WriteFile(fp, []byte(content), 0o644); err != nil {
		t.Fatalf("write SKILL.md: %v", err)
	}

	sk, err := LoadSkill(fp)
	if err != nil {
		t.Fatalf("LoadSkill: %v", err)
	}

	if sk.Name != "caveman" {
		t.Errorf("Name = %q, want %q", sk.Name, "caveman")
	}

	// Description must be assembled from block scalar, not the literal ">".
	if sk.Description == ">" {
		t.Fatal("Description is literal '>': block scalar was not parsed")
	}
	if sk.Description == "" {
		t.Fatal("Description is empty")
	}
	if !strings.Contains(sk.Description, "Ultra-compressed communication mode") {
		t.Errorf("Description missing expected text, got: %q", sk.Description)
	}
	if !strings.Contains(sk.Description, "65%") {
		t.Errorf("Description missing '65%%', got: %q", sk.Description)
	}
	// Should be folded (single space between lines, no stray newlines).
	if strings.Contains(sk.Description, "\n") {
		t.Errorf("Description contains newline (folded block scalar should not): %q", sk.Description)
	}

	if sk.Content == "" {
		t.Error("Content is empty")
	}
	if !strings.Contains(sk.Content, "Respond terse like smart caveman") {
		t.Errorf("Content missing expected text, got: %q", sk.Content)
	}
}

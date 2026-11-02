package plugins

import (
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
)

// gitRepo makes a git repository holding files and returns its file:// URL
// and a function that commits a new set of files on top.
func gitRepo(t *testing.T, files map[string]string) (string, func(map[string]string)) {
	t.Helper()
	dir := t.TempDir()
	run := func(args ...string) {
		t.Helper()
		cmd := exec.Command("git", args...)
		cmd.Dir = dir
		cmd.Env = append(os.Environ(), "GIT_AUTHOR_NAME=t", "GIT_AUTHOR_EMAIL=t@example.com", "GIT_COMMITTER_NAME=t", "GIT_COMMITTER_EMAIL=t@example.com")
		if out, err := cmd.CombinedOutput(); err != nil {
			t.Fatalf("git %v: %v\n%s", args, err, out)
		}
	}
	commit := func(files map[string]string) {
		t.Helper()
		for name, body := range files {
			path := filepath.Join(dir, filepath.FromSlash(name))
			if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(path, []byte(body), 0o644); err != nil {
				t.Fatal(err)
			}
		}
		run("add", "-A")
		run("commit", "-q", "-m", "change")
	}
	run("init", "-q", "-b", "main")
	commit(files)
	return "file://" + dir, commit
}

func isolate(t *testing.T) string {
	t.Helper()
	data := t.TempDir()
	t.Setenv("ION_DATA_DIR", data)
	return data
}

var vantageLike = map[string]string{
	".claude-plugin/plugin.json":      `{"name":"diagrams","description":"d"}`,
	".claude-plugin/marketplace.json": `{"name":"diagrams","plugins":[{"name":"diagrams","source":"./"}]}`,
	".mcp.json":                       `{"draw":{"command":"sh","args":["${CLAUDE_PLUGIN_ROOT}/scripts/mcp.sh"]}}`,
	"skills/draw-author/SKILL.md":     "---\nname: draw-author\ndescription: author\n---\nbody\n",
}

func TestInstall_RootPluginWithMcpAndSkills(t *testing.T) {
	isolate(t)
	url, _ := gitRepo(t, vantageLike)

	p, err := install(Source{ID: "owner/diagrams", URLs: []string{url}}, "", nil)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if p.Name != "diagrams" || p.Source != "owner/diagrams" || len(p.Version) != 12 {
		t.Fatalf("record = %+v", p)
	}
	if _, err := os.Stat(filepath.Join(p.InstallPath, "skills", "draw-author", "SKILL.md")); err != nil {
		t.Errorf("skill not installed: %v", err)
	}
	if _, err := os.Stat(filepath.Join(p.InstallPath, ".git")); !os.IsNotExist(err) {
		t.Errorf(".git kept in the install: %v", err)
	}

	servers := McpServers()
	draw, ok := servers["draw"]
	if !ok {
		t.Fatalf("plugin mcp server missing: %v", servers)
	}
	if draw.Type != "stdio" || draw.Command != "sh" || draw.Args[0] != p.InstallPath+"/scripts/mcp.sh" {
		t.Errorf("server not expanded: %+v", draw)
	}
	if draw.Env["CLAUDE_PLUGIN_ROOT"] != p.InstallPath || draw.Env["ION_PLUGIN_ROOT"] != p.InstallPath {
		t.Errorf("plugin root not in env: %v", draw.Env)
	}
}

func TestInstall_FallsBackToTheNextRemote(t *testing.T) {
	isolate(t)
	url, _ := gitRepo(t, vantageLike)
	missing := "file://" + filepath.Join(t.TempDir(), "absent")

	p, err := install(Source{ID: "owner/diagrams", URLs: []string{missing, url}}, "", nil)
	if err != nil {
		t.Fatalf("install: %v", err)
	}
	if p.URL != url {
		t.Errorf("fetched from %q, want %q", p.URL, url)
	}
}

func TestInstall_UnreachableSaysWhy(t *testing.T) {
	isolate(t)
	missing := "file://" + filepath.Join(t.TempDir(), "absent")
	_, err := install(Source{ID: "owner/absent", URLs: []string{missing}}, "", nil)
	if err == nil || !strings.Contains(err.Error(), "cannot reach the plugin repository") {
		t.Fatalf("err = %v", err)
	}
}

func TestUpdate_FetchesTheNewCommitAndDropsTheOld(t *testing.T) {
	isolate(t)
	url, commit := gitRepo(t, vantageLike)
	first, err := install(Source{ID: "owner/diagrams", URLs: []string{url}}, "", nil)
	if err != nil {
		t.Fatalf("install: %v", err)
	}

	if _, changed, err := Update("diagrams", nil); err != nil || changed {
		t.Fatalf("update with no new commit: changed=%v err=%v", changed, err)
	}

	commit(map[string]string{"skills/draw-review/SKILL.md": "---\nname: draw-review\ndescription: r\n---\n"})
	p, changed, err := Update("diagrams", nil)
	if err != nil || !changed {
		t.Fatalf("update: changed=%v err=%v", changed, err)
	}
	if p.Version == first.Version {
		t.Errorf("version did not move: %s", p.Version)
	}
	if _, err := os.Stat(filepath.Join(p.InstallPath, "skills", "draw-review", "SKILL.md")); err != nil {
		t.Errorf("new skill missing: %v", err)
	}
	if _, err := os.Stat(first.CheckoutPath); !os.IsNotExist(err) {
		t.Errorf("old checkout left behind: %v", err)
	}
	if installed, _ := ListInstalled(); len(installed) != 1 {
		t.Errorf("registry holds %d plugins, want 1", len(installed))
	}
}

func TestInstall_MarketplaceOfSeveral(t *testing.T) {
	isolate(t)
	url, _ := gitRepo(t, map[string]string{
		".claude-plugin/marketplace.json":        `{"name":"m","plugins":[{"name":"one","source":"./plugins/one"},{"name":"two","source":"./plugins/two"},{"name":"far","source":{"source":"github","repo":"a/b"}}]}`,
		"plugins/one/.claude-plugin/plugin.json": `{"name":"one"}`,
		"plugins/two/.claude-plugin/plugin.json": `{"name":"two","mcpServers":{"web":{"url":"https://example.com/mcp"}}}`,
	})
	src := Source{ID: "owner/m", URLs: []string{url}}

	if _, err := install(src, "", nil); err == nil || !strings.Contains(err.Error(), "far, one, two") {
		t.Fatalf("no name given: err = %v", err)
	}
	if _, err := install(src, "far", nil); err == nil || !strings.Contains(err.Error(), "another repository") {
		t.Fatalf("remote entry: err = %v", err)
	}
	p, err := install(src, "two", nil)
	if err != nil {
		t.Fatalf("install two: %v", err)
	}
	if filepath.Base(p.InstallPath) != "two" || p.Plugin != "two" {
		t.Errorf("record = %+v", p)
	}
	if web := McpServers()["web"]; web.Type != "http" || web.URL != "https://example.com/mcp" {
		t.Errorf("manifest server = %+v", web)
	}

	if _, err := install(src, "one", nil); err != nil {
		t.Fatalf("install one: %v", err)
	}
	if err := Remove("two"); err != nil {
		t.Fatalf("remove two: %v", err)
	}
	if _, err := os.Stat(p.CheckoutPath); err != nil {
		t.Errorf("shared checkout removed while one still uses it: %v", err)
	}
	if err := Remove("one"); err != nil {
		t.Fatalf("remove one: %v", err)
	}
	if _, err := os.Stat(p.CheckoutPath); !os.IsNotExist(err) {
		t.Errorf("checkout left after its last plugin went: %v", err)
	}
}

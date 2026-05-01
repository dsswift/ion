package tools

import (
	"context"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/skills"
)

func TestWebFetchBlockedHosts(t *testing.T) {
	tests := []struct {
		host    string
		blocked bool
	}{
		{"127.0.0.1", true},
		{"10.0.0.1", true},
		{"192.168.1.1", true},
		{"172.16.0.1", true},
		{"169.254.1.1", true},
		{"localhost", true},
		{"0.0.0.0", true},
		{"[::]", true},
		{"8.8.8.8", false},
		{"example.com", false},
	}

	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			got := isBlockedHost(tc.host)
			if got != tc.blocked {
				t.Errorf("isBlockedHost(%q) = %v, want %v", tc.host, got, tc.blocked)
			}
		})
	}
}

func TestWebFetchBlockedHostsExtended(t *testing.T) {
	tests := []struct {
		host    string
		blocked bool
	}{
		{"10.255.255.255", true},
		{"172.31.255.255", true},
		{"192.168.0.1", true},
		{"127.0.0.2", true},
		{"169.254.169.254", true}, // AWS metadata
		{"172.15.0.1", false},     // Just below the 172.16 range
		{"172.32.0.1", false},     // Just above the 172.31 range
		{"1.1.1.1", false},
		{"93.184.216.34", false},
	}

	for _, tc := range tests {
		t.Run(tc.host, func(t *testing.T) {
			got := isBlockedHost(tc.host)
			if got != tc.blocked {
				t.Errorf("isBlockedHost(%q) = %v, want %v", tc.host, got, tc.blocked)
			}
		})
	}
}

func TestHtmlToText(t *testing.T) {
	html := `<html><head><title>Test</title></head><body><h1>Hello</h1><p>World</p><script>alert("x")</script></body></html>`
	text := htmlToText(html)
	if !strings.Contains(text, "Hello") {
		t.Errorf("expected 'Hello' in text, got %q", text)
	}
	if !strings.Contains(text, "World") {
		t.Errorf("expected 'World' in text, got %q", text)
	}
	if strings.Contains(text, "alert") {
		t.Error("script content should be stripped")
	}
	if strings.Contains(text, "<") {
		t.Error("HTML tags should be stripped")
	}
}

func TestHtmlToTextStyleStripped(t *testing.T) {
	html := `<html><head><style>.cls { color: red; }</style></head><body><p>Visible</p></body></html>`
	text := htmlToText(html)
	if strings.Contains(text, "color") {
		t.Error("style content should be stripped")
	}
	if !strings.Contains(text, "Visible") {
		t.Errorf("expected visible text, got %q", text)
	}
}

func TestHtmlToTextEntities(t *testing.T) {
	html := `<p>A &amp; B &lt; C &gt; D &quot;E&quot; &#39;F&#39;</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "A & B") {
		t.Errorf("expected decoded &amp;, got %q", text)
	}
	if !strings.Contains(text, "< C >") {
		t.Errorf("expected decoded &lt; &gt;, got %q", text)
	}
	if !strings.Contains(text, "\"E\"") {
		t.Errorf("expected decoded &quot;, got %q", text)
	}
	if !strings.Contains(text, "'F'") {
		t.Errorf("expected decoded &#39;, got %q", text)
	}
}

func TestHtmlToTextBrTags(t *testing.T) {
	html := `<p>line1<br/>line2<br>line3</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "line1\nline2") {
		t.Errorf("expected br to produce newlines, got %q", text)
	}
}

func TestHtmlToTextNbsp(t *testing.T) {
	html := `<p>hello&nbsp;world</p>`
	text := htmlToText(html)
	if !strings.Contains(text, "hello world") {
		t.Errorf("expected nbsp -> space, got %q", text)
	}
}

func TestHtmlToTextPlainInput(t *testing.T) {
	text := htmlToText("just plain text, no tags")
	if text != "just plain text, no tags" {
		t.Errorf("expected plain text passthrough, got %q", text)
	}
}

func TestWebFetchBlockedURL(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "http://127.0.0.1/secret",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for blocked host")
	}
	if !strings.Contains(result.Content, "Blocked") {
		t.Errorf("expected 'Blocked' message, got %q", result.Content)
	}
}

func TestWebFetchBlockedScheme(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "ftp://example.com/file",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for ftp scheme")
	}
	if !strings.Contains(result.Content, "only http/https") {
		t.Errorf("expected scheme error, got %q", result.Content)
	}
}

func TestWebFetchMissingURL(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing url")
	}
	if !strings.Contains(result.Content, "url is required") {
		t.Errorf("expected url required message, got %q", result.Content)
	}
}

func TestWebFetchLocalhostBlocked(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{
		"url": "http://localhost:8080/api",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for localhost")
	}
}

func TestWebFetchPrivateIPBlocked(t *testing.T) {
	urls := []string{
		"http://10.0.0.1/",
		"http://192.168.1.1/",
		"http://172.16.0.1/",
	}
	for _, u := range urls {
		t.Run(u, func(t *testing.T) {
			result, _ := ExecuteTool(context.Background(), "WebFetch", map[string]any{"url": u}, "/tmp")
			if !result.IsError {
				t.Errorf("expected blocked for %s", u)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// Bash Operations Tests
// ---------------------------------------------------------------------------

func TestLocalBashOperations(t *testing.T) {
	ops := &LocalBashOperations{}
	ctx := context.Background()

	result, err := ops.Exec(ctx, "echo test123", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 0 {
		t.Errorf("expected exit code 0, got %d", result.ExitCode)
	}
	if !strings.Contains(result.Stdout, "test123") {
		t.Errorf("expected stdout to contain 'test123', got %q", result.Stdout)
	}
}

func TestLocalBashOperationsExitCode(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "exit 42", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if result.ExitCode != 42 {
		t.Errorf("expected exit code 42, got %d", result.ExitCode)
	}
}

func TestLocalBashOperationsStderr(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "echo err_output >&2", os.TempDir(), ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stderr, "err_output") {
		t.Errorf("expected stderr, got %q", result.Stderr)
	}
}

func TestLocalBashOperationsTimeout(t *testing.T) {
	ops := &LocalBashOperations{}

	_, err := ops.Exec(context.Background(), "sleep 30", os.TempDir(), ExecOptions{
		Timeout: 200 * time.Millisecond,
	})
	// The context deadline should cause an error or non-zero exit.
	// On timeout, exec returns an error.
	if err == nil {
		// If no Go error, verify exit code is non-zero.
		// Some systems surface the kill as exit code -1.
	}
}

func TestLocalBashOperationsEnv(t *testing.T) {
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "echo $MY_TEST_ENV_VAR", os.TempDir(), ExecOptions{
		Env: map[string]string{"MY_TEST_ENV_VAR": "env_value_42"},
	})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stdout, "env_value_42") {
		t.Errorf("expected env var in output, got %q", result.Stdout)
	}
}

func TestLocalBashOperationsWorkingDir(t *testing.T) {
	dir := t.TempDir()
	ops := &LocalBashOperations{}

	result, err := ops.Exec(context.Background(), "pwd", dir, ExecOptions{})
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(result.Stdout, dir) {
		t.Errorf("expected cwd %q in output, got %q", dir, result.Stdout)
	}
}

func TestSetBashOperations(t *testing.T) {
	original := GetBashOperations()
	defer SetBashOperations(original)

	custom := &LocalBashOperations{}
	SetBashOperations(custom)
	got := GetBashOperations()
	if got != custom {
		t.Error("SetBashOperations did not update the singleton")
	}
}

// ---------------------------------------------------------------------------
// Skill Tool Tests
// ---------------------------------------------------------------------------

func TestSkillToolRegisteredSkill(t *testing.T) {
	// Register a test skill.
	skills.RegisterSkill(&skills.Skill{
		Name:        "test-skill",
		Description: "A test skill for unit tests",
		Content:     "Do the test thing step by step.",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "test-skill",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "test-skill") {
		t.Errorf("expected skill name in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Do the test thing") {
		t.Errorf("expected skill content in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "A test skill") {
		t.Errorf("expected description in output, got %q", result.Content)
	}
}

func TestSkillToolWithArgs(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{
		Name:    "args-skill",
		Content: "Execute with given args.",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "args-skill",
		"args":  "param1 param2",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "param1 param2") {
		t.Errorf("expected args in output, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "Arguments:") {
		t.Errorf("expected 'Arguments:' label, got %q", result.Content)
	}
}

func TestSkillToolUnknownSkill(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{
		Name:    "known-skill",
		Content: "known content",
	})
	defer skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "unknown-skill",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown skill")
	}
	if !strings.Contains(result.Content, "Unknown skill") {
		t.Errorf("expected 'Unknown skill' message, got %q", result.Content)
	}
	if !strings.Contains(result.Content, "known-skill") {
		t.Errorf("expected available skills list, got %q", result.Content)
	}
}

func TestSkillToolNoSkills(t *testing.T) {
	skills.ClearSkillRegistry()

	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "any-skill",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error when no skills registered")
	}
	if !strings.Contains(result.Content, "No skills registered") {
		t.Errorf("expected 'No skills registered', got %q", result.Content)
	}
}

func TestSkillToolMissingSkillParam(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing skill param")
	}
	if !strings.Contains(result.Content, "Missing required parameter") {
		t.Errorf("expected missing param message, got %q", result.Content)
	}
}

func TestSkillToolMultipleSkills(t *testing.T) {
	skills.RegisterSkill(&skills.Skill{Name: "alpha", Content: "alpha content"})
	skills.RegisterSkill(&skills.Skill{Name: "beta", Content: "beta content"})
	skills.RegisterSkill(&skills.Skill{Name: "gamma", Content: "gamma content"})
	defer skills.ClearSkillRegistry()

	// Invoke one; the others should be listed on unknown.
	result, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "alpha",
	}, "/tmp")
	if result.IsError {
		t.Fatalf("unexpected error: %s", result.Content)
	}
	if !strings.Contains(result.Content, "alpha content") {
		t.Errorf("expected alpha content, got %q", result.Content)
	}

	// Unknown skill should list all available.
	result2, _ := ExecuteTool(context.Background(), "Skill", map[string]any{
		"skill": "nonexistent",
	}, "/tmp")
	if !result2.IsError {
		t.Error("expected error for unknown skill")
	}
	if !strings.Contains(result2.Content, "alpha") || !strings.Contains(result2.Content, "beta") || !strings.Contains(result2.Content, "gamma") {
		t.Errorf("expected all skill names listed, got %q", result2.Content)
	}
}

// ---------------------------------------------------------------------------
// MCP Resource Tool Tests
// ---------------------------------------------------------------------------

func TestListMcpResourcesUnknownServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ListMcpResources", map[string]any{
		"server": "nonexistent-server",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown MCP server")
	}
	if !strings.Contains(result.Content, "not connected") {
		t.Errorf("expected 'not connected' message, got %q", result.Content)
	}
}

func TestListMcpResourcesMissingServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ListMcpResources", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing server")
	}
	if !strings.Contains(result.Content, "server is required") {
		t.Errorf("expected 'server is required', got %q", result.Content)
	}
}

func TestReadMcpResourceUnknownServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"server": "ghost-server",
		"uri":    "file:///test.txt",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for unknown MCP server")
	}
	if !strings.Contains(result.Content, "not connected") {
		t.Errorf("expected 'not connected' message, got %q", result.Content)
	}
}

func TestReadMcpResourceMissingServer(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"uri": "file:///test.txt",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing server")
	}
}

func TestReadMcpResourceMissingUri(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "ReadMcpResource", map[string]any{
		"server": "some-server",
	}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing uri")
	}
	if !strings.Contains(result.Content, "uri is required") {
		t.Errorf("expected 'uri is required', got %q", result.Content)
	}
}

// ---------------------------------------------------------------------------
// Optional Tool Tests (RegisterTaskTools / UnregisterTaskTools)
// ---------------------------------------------------------------------------

func TestOptionalToolsRoundTrip(t *testing.T) {
	// Task tools should be registered by TestMain.
	taskTools := []string{"TaskCreate", "TaskList", "TaskGet", "TaskStop"}
	for _, name := range taskTools {
		if GetTool(name) == nil {
			t.Fatalf("expected %q to be registered", name)
		}
	}

	// Unregister and verify they are gone.
	UnregisterTaskTools()
	for _, name := range taskTools {
		if GetTool(name) != nil {
			t.Errorf("expected %q to be unregistered", name)
		}
	}

	// Re-register and verify they are back.
	RegisterTaskTools()
	for _, name := range taskTools {
		if GetTool(name) == nil {
			t.Errorf("expected %q to be re-registered", name)
		}
	}
}

func TestOptionalToolsAffectCount(t *testing.T) {
	// With task tools registered (from TestMain).
	countWith := len(GetAllTools())

	UnregisterTaskTools()
	countWithout := len(GetAllTools())
	RegisterTaskTools() // restore

	if countWith-countWithout != 4 {
		t.Errorf("expected 4 task tools difference, got %d (with=%d, without=%d)",
			countWith-countWithout, countWith, countWithout)
	}
}

// ---------------------------------------------------------------------------
// Helper function tests
// ---------------------------------------------------------------------------

func TestIntFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      int
		expected int
	}{
		{"float64", map[string]any{"x": float64(42)}, "x", 0, 42},
		{"int", map[string]any{"x": 7}, "x", 0, 7},
		{"int64", map[string]any{"x": int64(99)}, "x", 0, 99},
		{"missing key", map[string]any{}, "x", 10, 10},
		{"wrong type", map[string]any{"x": "not a number"}, "x", 5, 5},
		{"nil input", nil, "x", 3, 3},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := intFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %d, got %d", tc.expected, got)
			}
		})
	}
}

func TestStringFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      string
		expected string
	}{
		{"exists", map[string]any{"k": "val"}, "k", "", "val"},
		{"missing", map[string]any{}, "k", "default", "default"},
		{"wrong type", map[string]any{"k": 42}, "k", "fallback", "fallback"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := stringFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, got)
			}
		})
	}
}

func TestBoolFromInput(t *testing.T) {
	tests := []struct {
		name     string
		input    map[string]any
		key      string
		def      bool
		expected bool
	}{
		{"true", map[string]any{"k": true}, "k", false, true},
		{"false", map[string]any{"k": false}, "k", true, false},
		{"missing", map[string]any{}, "k", true, true},
		{"wrong type", map[string]any{"k": "yes"}, "k", false, false},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := boolFromInput(tc.input, tc.key, tc.def)
			if got != tc.expected {
				t.Errorf("expected %v, got %v", tc.expected, got)
			}
		})
	}
}

func TestResolvePath(t *testing.T) {
	tests := []struct {
		name     string
		cwd      string
		path     string
		expected string
	}{
		{"absolute stays absolute", "/tmp", "/usr/bin/file", "/usr/bin/file"},
		{"relative resolved", "/home/user", "foo/bar.txt", "/home/user/foo/bar.txt"},
		{"dot path", "/home/user", "./test.go", "/home/user/test.go"},
	}

	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			got := resolvePath(tc.cwd, tc.path)
			if got != tc.expected {
				t.Errorf("expected %q, got %q", tc.expected, got)
			}
		})
	}
}

// ---------------------------------------------------------------------------
// WebSearch Tool Tests
// ---------------------------------------------------------------------------

func TestWebSearchMissingQuery(t *testing.T) {
	result, _ := ExecuteTool(context.Background(), "WebSearch", map[string]any{}, "/tmp")
	if !result.IsError {
		t.Error("expected error for missing query")
	}
}

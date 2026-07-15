package session

import (
	"os"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/plugins"
	"github.com/dsswift/ion/engine/internal/session/agents"
	"github.com/dsswift/ion/engine/internal/session/pending"
)

// ---------------------------------------------------------------------------
// Plugin UserPromptSubmit hook wiring tests
// ---------------------------------------------------------------------------
//
// These tests pin the behavior introduced by the system-reminder injection fix:
//
//  1. OnInitialMessages is wired unconditionally when pluginUserPromptHooks are
//     present — even with no extension group. The hook output is returned as
//     []types.LlmMessage (role=user, content=<system-reminder>...</system-reminder>)
//     rather than appended to sysPrompt, matching Claude Code's hook injection.
//
//  2. The prompt is passed to the hook subprocess via stdin as
//     {"prompt":"..."} JSON, matching the Claude Code hook protocol.
//     Without stdin, hooks like caveman-mode-tracker.js receive an
//     immediate EOF, fail JSON.parse silently, and produce no output.
//
//  3. Multiple hooks all contribute messages — none are dropped.

// newPluginTestSession creates a minimal engineSession for plugin hook tests.
func newPluginTestSession(key string) *engineSession {
	return &engineSession{
		key:       key,
		config:    defaultConfig(),
		agents:    agents.NewRegistry(),
		childPIDs: make(map[int]struct{}),
		pending:   pending.New(),
	}
}

// writeEchoPromptScript writes a Node.js script that reads JSON from stdin
// and echoes data.prompt to stdout. Skips the test if node is not on PATH.
func writeEchoPromptScript(t *testing.T) string {
	t.Helper()
	dir := t.TempDir()
	script := dir + "/echo-prompt.js"
	if err := os.WriteFile(script, []byte(`
let input = '';
process.stdin.on('data', chunk => { input += chunk; });
process.stdin.on('end', () => {
  try {
    const data = JSON.parse(input);
    process.stdout.write('plugin:' + data.prompt);
  } catch(e) {
    process.stdout.write('parse-error');
  }
});
`), 0o755); err != nil {
		t.Fatalf("write echo-prompt script: %v", err)
	}
	return script
}

// TestPluginUserPromptHooks_FireWithoutExtGroup verifies that OnInitialMessages
// is wired and plugin hooks fire even when no TS/Go extension group is attached.
// The hook output must appear as a <system-reminder> user message, not in sysPrompt.
func TestPluginUserPromptHooks_FireWithoutExtGroup(t *testing.T) {
	script := writeEchoPromptScript(t)

	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	s := newPluginTestSession("plugin-no-ext")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"plugin-no-ext": s}
	mgr.mu.Unlock()

	s.pluginUserPromptHooks = []pluginUserPromptCmd{
		{
			Entry: plugins.PluginHookEntry{
				Type:    "command",
				Command: "node " + script,
				Timeout: 5,
			},
			PluginRoot: t.TempDir(),
		},
	}

	runCfg := mgr.buildRunConfig(s, "plugin-no-ext", "req-no-ext",
		apiBackend, nil /* extGroup */, false /* skipExtensions */,
		nil, nil, nil, "")

	// Plugin hooks now wire OnInitialMessages, not OnBeforePrompt.
	if runCfg.Hooks.OnInitialMessages == nil {
		t.Fatal("expected OnInitialMessages to be wired when pluginUserPromptHooks present, got nil")
	}

	msgs := runCfg.Hooks.OnInitialMessages("req-no-ext", "hello")
	if len(msgs) == 0 {
		t.Fatal("expected at least one message from OnInitialMessages, got none")
	}
	content := ""
	for _, m := range msgs {
		if s, ok := m.Content.(string); ok {
			content += s
		}
	}
	if !strings.Contains(content, "plugin:hello") {
		t.Errorf("message content = %q; want to contain %q", content, "plugin:hello")
	}
	// Must be wrapped in <system-reminder>.
	if !strings.Contains(content, "<system-reminder>") {
		t.Errorf("message content missing <system-reminder> wrapper: %q", content)
	}
	// Must NOT be in sysPrompt — the hook moved off OnBeforePrompt.
	if runCfg.Hooks.OnBeforePrompt != nil {
		_, sysPrompt := runCfg.Hooks.OnBeforePrompt("req-no-ext", "hello")
		if strings.Contains(sysPrompt, "plugin:hello") {
			t.Errorf("plugin output must not appear in sysPrompt; got: %q", sysPrompt)
		}
	}
}

// TestPluginUserPromptHooks_MultipleHooksAllContribute verifies that multiple
// plugin hooks each contribute a message to OnInitialMessages output.
func TestPluginUserPromptHooks_MultipleHooksAllContribute(t *testing.T) {
	script := writeEchoPromptScript(t)

	apiBackend := backend.NewApiBackend()
	mgr := NewManager(apiBackend)
	s := newPluginTestSession("plugin-multi")
	mgr.mu.Lock()
	mgr.sessions = map[string]*engineSession{"plugin-multi": s}
	mgr.mu.Unlock()

	s.pluginUserPromptHooks = []pluginUserPromptCmd{
		{
			Entry: plugins.PluginHookEntry{
				Type:    "command",
				Command: "node " + script,
				Timeout: 5,
			},
			PluginRoot: t.TempDir(),
		},
		{
			// Second hook: static output to confirm both hooks contribute.
			Entry: plugins.PluginHookEntry{
				Type:    "command",
				Command: "echo second-hook",
				Timeout: 5,
			},
			PluginRoot: t.TempDir(),
		},
	}

	runCfg := mgr.buildRunConfig(s, "plugin-multi", "req-multi",
		apiBackend, nil, false, nil, nil, nil, "")

	if runCfg.Hooks.OnInitialMessages == nil {
		t.Fatal("expected OnInitialMessages to be wired")
	}

	msgs := runCfg.Hooks.OnInitialMessages("req-multi", "world")
	if len(msgs) < 2 {
		t.Fatalf("expected at least 2 messages (one per hook), got %d", len(msgs))
	}

	allContent := ""
	for _, m := range msgs {
		if s, ok := m.Content.(string); ok {
			allContent += s
		}
	}
	if !strings.Contains(allContent, "plugin:world") {
		t.Errorf("messages missing first hook output: %q", allContent)
	}
	if !strings.Contains(allContent, "second-hook") {
		t.Errorf("messages missing second hook output: %q", allContent)
	}
}

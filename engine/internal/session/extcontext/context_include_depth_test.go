package extcontext

import (
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

// engine.json limits.contextIncludeMaxDepth also caps the @-includes a
// dispatched child's grounding follows.
func TestInjectDispatchContext_IncludeMaxDepthFromEngineConfig(t *testing.T) {
	dir := t.TempDir()
	for name, body := range map[string]string{"AGENTS.md": "@one.md", "one.md": "ONE\n@two.md", "two.md": "TWO"} {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	depth := 1
	sa := &dispatchContextTestAccessor{engineConfig: &types.EngineRuntimeConfig{Limits: types.LimitsConfig{ContextIncludeMaxDepth: &depth}}}
	opts := &extension.DispatchAgentOpts{WaitForCompletion: true, Name: "child", SystemPrompt: "PERSONA"}

	injectDispatchContext("child", dir, opts, sa)

	if !strings.Contains(opts.SystemPrompt, "ONE") || strings.Contains(opts.SystemPrompt, "TWO") {
		t.Fatalf("depth 1 must stop at one.md:\n%s", opts.SystemPrompt)
	}
	if !strings.Contains(opts.SystemPrompt, "max include depth reached: two.md") {
		t.Fatalf("missing the cap marker:\n%s", opts.SystemPrompt)
	}
}

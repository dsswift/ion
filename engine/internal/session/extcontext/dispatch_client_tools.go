package extcontext

import (
	"context"
	"fmt"

	"github.com/dsswift/ion/engine/internal/backend"
	"github.com/dsswift/ion/engine/internal/types"
)

// wireChildClientTools carries the parent session's filtered client-tool
// runtime into a dispatched child. API children use RunConfig; delegated CLI
// children use the same fields through BuildDelegatedChildToolServer or Codex
// dynamic tools. The optional accessor keeps dispatch test doubles unchanged.
func wireChildClientTools(sa SessionAccessor, opts *types.RunOptions, cfg *backend.RunConfig) {
	runtime, ok := sa.(interface {
		BuildClientToolRuntime(*types.RunOptions)
	})
	if !ok || cfg == nil {
		return
	}
	runtime.BuildClientToolRuntime(opts)
	if len(opts.ClientTools) == 0 || opts.ClientToolRouter == nil {
		return
	}

	existing := make(map[string]bool, len(cfg.ExternalTools))
	for _, def := range cfg.ExternalTools {
		existing[def.Name] = true
	}
	clientNames := make(map[string]bool, len(opts.ClientTools))
	for _, tool := range opts.ClientTools {
		if tool.HumanWait || existing[tool.Name] {
			continue
		}
		cfg.ExternalTools = append(cfg.ExternalTools, tool.LlmToolDef())
		clientNames[tool.Name] = true
	}
	if len(clientNames) == 0 {
		return
	}
	prior := cfg.McpToolRouter
	router := opts.ClientToolRouter
	cfg.McpToolRouter = func(ctx context.Context, name string, input map[string]interface{}) (*types.ToolResult, error) {
		if clientNames[name] {
			return router(ctx, name, input), nil
		}
		if prior != nil {
			return prior(ctx, name, input)
		}
		return nil, fmt.Errorf("external tool %q not found", name)
	}
}

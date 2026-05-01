package extension

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)


// transpileTS bundles a TypeScript file to JavaScript using the esbuild CLI.
// Returns the path to the bundled .mjs file. The output lands in a
// `.ion-build/` directory inside the extension's own folder so Node's ESM
// resolver can walk up and find the extension's node_modules for any
// declared external packages.
//
// The optional manifest contributes additional `--external:<name>` flags
// so declared external packages (typically native modules) are not
// bundled and instead resolve at runtime from `<extDir>/node_modules`.
func (h *Host) transpileTS(tsPath string, manifest *Manifest) (string, error) {
	extDir := filepath.Dir(tsPath)
	buildDir := filepath.Join(extDir, ".ion-build")
	if err := os.MkdirAll(buildDir, 0755); err != nil {
		return "", fmt.Errorf("create build dir: %w", err)
	}
	// Plant a .gitignore so build artifacts don't accidentally land in
	// version control. Best-effort; ignore errors.
	gitignore := filepath.Join(buildDir, ".gitignore")
	if _, err := os.Stat(gitignore); os.IsNotExist(err) {
		_ = os.WriteFile(gitignore, []byte("*\n"), 0644)
	}
	// Output as .mjs so Node treats the bundle as ESM regardless of any
	// package.json `type` field nearby. ESM is required for top-level
	// `await` in extension code, which Node 20 supports natively.
	outPath := filepath.Join(buildDir, fmt.Sprintf("ext-%d.mjs", time.Now().UnixNano()))

	esbuildBin := "esbuild"
	// Look in common locations when esbuild isn't in PATH (daemon mode)
	if _, err := exec.LookPath(esbuildBin); err != nil {
		for _, candidate := range []string{
			"/opt/homebrew/bin/esbuild",
			"/usr/local/bin/esbuild",
		} {
			if _, err := os.Stat(candidate); err == nil {
				esbuildBin = candidate
				break
			}
		}
	}
	args := []string{
		tsPath,
		"--bundle",
		"--format=esm",
		"--target=node20",
		"--platform=node",
		"--sourcemap=inline",
		"--outfile=" + outPath,
		"--external:child_process",
		"--external:fs",
		"--external:path",
		"--external:os",
		"--external:net",
		"--external:crypto",
		"--external:events",
		"--external:readline",
		"--external:stream",
		"--external:util",
		"--external:node:*",
	}
	if manifest != nil {
		for _, dep := range manifest.External {
			if dep == "" {
				continue
			}
			args = append(args, "--external:"+dep)
		}
	}
	cmd := exec.Command(esbuildBin, args...)
	var stderr bytes.Buffer
	cmd.Stderr = &stderr

	if err := cmd.Run(); err != nil {
		return "", fmt.Errorf("esbuild failed: %w\n%s\n(install with: npm i -g esbuild)", err, stderr.String())
	}

	utils.Log("extension", fmt.Sprintf("transpiled %s -> %s", tsPath, outPath))
	return outPath, nil
}

// ensureNodeModules runs `npm install` for an extension that ships a
// package.json. Idempotent: when node_modules already exists and is at
// least as new as package.json, the install is skipped. The first install
// has a 120 s timeout so a hung registry doesn't deadlock the engine.
//
// Extensions without package.json are a no-op. The engine bundles its
// own SDK, so most extensions need no install step at all.
func ensureNodeModules(extDir string) error {
	pkgPath := filepath.Join(extDir, "package.json")
	pkgInfo, err := os.Stat(pkgPath)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return fmt.Errorf("stat %s: %w", pkgPath, err)
	}

	nodeModules := filepath.Join(extDir, "node_modules")
	nmInfo, nmErr := os.Stat(nodeModules)
	if nmErr == nil && nmInfo.IsDir() {
		// node_modules already exists. Compare against the resolution
		// stamp file (lockfile or .package-lock.json) to decide whether
		// the install is stale.
		stampCandidates := []string{
			filepath.Join(nodeModules, ".package-lock.json"),
			filepath.Join(extDir, "package-lock.json"),
			filepath.Join(extDir, "npm-shrinkwrap.json"),
		}
		var newest time.Time
		for _, candidate := range stampCandidates {
			if st, err := os.Stat(candidate); err == nil && st.ModTime().After(newest) {
				newest = st.ModTime()
			}
		}
		if !newest.IsZero() && !pkgInfo.ModTime().After(newest) {
			utils.Log("extension", fmt.Sprintf("node_modules up to date in %s", extDir))
			return nil
		}
	}

	npmBin := "npm"
	if _, err := exec.LookPath(npmBin); err != nil {
		for _, candidate := range []string{
			"/opt/homebrew/bin/npm",
			"/usr/local/bin/npm",
		} {
			if _, serr := os.Stat(candidate); serr == nil {
				npmBin = candidate
				break
			}
		}
	}

	utils.Log("extension", fmt.Sprintf("running npm install in %s", extDir))

	ctx, cancel := context.WithTimeout(context.Background(), 120*time.Second)
	defer cancel()

	cmd := exec.CommandContext(ctx, npmBin, "install",
		"--omit=dev",
		"--no-fund",
		"--no-audit",
		"--no-progress",
	)
	cmd.Dir = extDir
	var stderr bytes.Buffer
	cmd.Stderr = &stderr
	cmd.Stdout = &stderr // collapse to single buffer
	if err := cmd.Run(); err != nil {
		return fmt.Errorf("npm install in %s: %w\n%s", extDir, err, stderr.String())
	}
	utils.Log("extension", fmt.Sprintf("npm install completed in %s", extDir))
	return nil
}

// parseInitResult extracts tools and commands from the subprocess init response
// and registers them on the SDK.
func (h *Host) parseInitResult(raw json.RawMessage) {
	if len(raw) == 0 || string(raw) == "null" {
		return
	}

	var result struct {
		Name  string `json:"name"`
		Tools []struct {
			Name        string                 `json:"name"`
			Description string                 `json:"description"`
			Parameters  map[string]interface{} `json:"parameters"`
		} `json:"tools"`
		Commands map[string]struct {
			Description string `json:"description"`
		} `json:"commands"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		utils.Log("extension", fmt.Sprintf("init result parse error: %v", err))
		return
	}

	if result.Name != "" {
		h.name = result.Name
	}

	for _, t := range result.Tools {
		toolName := t.Name // capture for closure
		h.sdk.RegisterTool(ToolDefinition{
			Name:        t.Name,
			Description: t.Description,
			Parameters:  t.Parameters,
			Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
				h.currentCtx.Store(ctx)
				defer h.currentCtx.Store(nil)
				raw, err := h.call("tool/"+toolName, params)
				if err != nil {
					return &types.ToolResult{Content: err.Error(), IsError: true}, nil
				}
				if len(raw) == 0 || string(raw) == "null" {
					return &types.ToolResult{Content: ""}, nil
				}
				var content interface{}
				if err := json.Unmarshal(raw, &content); err != nil {
					return &types.ToolResult{Content: string(raw)}, nil
				}
				formatted, _ := json.MarshalIndent(content, "", "  ")
				return &types.ToolResult{Content: string(formatted)}, nil
			},
		})
	}

	for name, def := range result.Commands {
		cmdName := name // capture for closure
		h.sdk.RegisterCommand(name, CommandDefinition{
			Description: def.Description,
			Execute: func(args string, ctx *Context) error {
				h.currentCtx.Store(ctx)
				defer h.currentCtx.Store(nil)
				_, err := h.call("command/"+cmdName, map[string]string{"args": args})
				return err
			},
		})
	}

	if len(result.Tools) > 0 || len(result.Commands) > 0 {
		utils.Log("extension", fmt.Sprintf("registered %d tools, %d commands from init",
			len(result.Tools), len(result.Commands)))
	}
}

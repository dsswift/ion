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
		_ = os.WriteFile(gitignore, []byte("*\n"), 0644) //nolint:errcheck // best-effort .gitignore for build artifacts; comment above documents intent
	}
	// Reap bundles orphaned by previous engine lifetimes before writing
	// another. Dispose deletes the bundles a host created, but Dispose only
	// runs on a graceful teardown — and the daemon is routinely killed rather
	// than shut down (`launchctl kickstart -k` on every desktop upgrade that
	// ships a new binary, a crash, a machine restart). Bundles from a killed
	// lifetime are orphaned permanently, and nothing else ever looks at them.
	//
	// Without a sweep the directory grows without bound for as long as the
	// extension exists. Measured on a live installation: 10,348 bundles /
	// 12 GB for one extension, 14 GB across three, over roughly three months.
	// Each bundle is ~1.2 MB and every extension load writes a new one, so a
	// dispatch-heavy session adds dozens per minute.
	//
	// The sweep lives on the transpile path rather than on a timer or at
	// daemon startup because this is the one function that creates the
	// garbage: a reaper attached to the writer cannot drift out of sync with
	// it, and it needs no lifecycle wiring of its own.
	reapStaleBundles(buildDir)

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

	utils.LogWithFields(utils.LevelInfo, "extension", "transpiled ->", map[string]any{"ts_path": tsPath, "out_path": outPath})
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
			utils.LogWithFields(utils.LevelInfo, "extension", "node_modules up to date in", map[string]any{"ext_dir": extDir})
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

	utils.LogWithFields(utils.LevelInfo, "extension", "running npm install in", map[string]any{"ext_dir": extDir})

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
	utils.LogWithFields(utils.LevelInfo, "extension", "npm install completed in", map[string]any{"ext_dir": extDir})
	return nil
}

// parseInitResult extracts tools and commands from the subprocess init response,
// validates build identity, and registers them on the SDK.
func (h *Host) parseInitResult(raw json.RawMessage) error {
	if len(raw) == 0 || string(raw) == "null" {
		return nil
	}

	var result struct {
		Name  string `json:"name"`
		Tools []struct {
			Name         string                 `json:"name"`
			Description  string                 `json:"description"`
			Parameters   map[string]interface{} `json:"parameters"`
			PlanModeSafe bool                   `json:"planModeSafe"`
		} `json:"tools"`
		Commands map[string]struct {
			Description string `json:"description"`
		} `json:"commands"`
		// Async triggers declared at init time. Both are optional —
		// extensions that register no webhooks / schedules at module
		// scope omit them entirely. We stash the decoded values onto
		// the host's pending-init buffer and the session manager
		// commits them after wiring the lifecycle-hook callback so
		// init-time vetoes can fire correctly.
		Webhooks  []WebhookRoute `json:"webhooks,omitempty"`
		Schedules []ScheduleJob  `json:"schedules,omitempty"`
		// Resource kinds declared at init time (optional). The session
		// wires them into the broker after the extension is fully loaded.
		Resources []types.ResourceDeclaration `json:"resources,omitempty"`
		// Hooks is the subprocess's registered callback set. It is additive
		// handshake metadata, distinct from engine-installed transport forwarders.
		Hooks []string `json:"hooks,omitempty"`
		// Build identity reported by the SDK subprocess. Compared against
		// the engine's own build identity to detect mixed-build runtimes.
		BuildIdentity string `json:"buildIdentity,omitempty"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		utils.LogWithFields(utils.LevelError, "extension", "init result parse error", map[string]any{"error": err})
		return fmt.Errorf("decode init result: %w", err)
	}

	if err := h.validateBuildIdentity(result.BuildIdentity); err != nil {
		return err
	}

	if result.Name != "" {
		h.setName(result.Name)
	}
	h.setDeclaredHooks(result.Hooks)

	for _, t := range result.Tools {
		toolName := t.Name // capture for closure
		h.sdk.RegisterTool(ToolDefinition{
			Name:         t.Name,
			Description:  t.Description,
			Parameters:   t.Parameters,
			PlanModeSafe: t.PlanModeSafe,
			Execute: func(params interface{}, ctx *Context) (*types.ToolResult, error) {
				raw, err := h.callHook("tool/"+toolName, ctx, params)
				if err != nil {
					return &types.ToolResult{Content: err.Error(), IsError: true}, nil
				}
				if len(raw) == 0 || string(raw) == "null" {
					return &types.ToolResult{Content: ""}, nil
				}
				// Structured tool return: image paths and/or typed contentItems.
				// Typed vision items stay ephemeral; they feed this provider turn but
				// never become durable event or conversation payloads.
				if result, ok := parseToolResultWithImages(raw, h.name_()); ok {
					utils.LogWithFields(utils.LevelInfo, "extension", "tool returned structured result", map[string]any{
						"tag":          h.name_(),
						"tool":         toolName,
						"images":       len(result.Images),
						"contentItems": len(result.ContentItems),
					})
					return result, nil
				}
				var content interface{}
				if err := json.Unmarshal(raw, &content); err != nil {
					return &types.ToolResult{Content: string(raw)}, nil
				}
				formatted, _ := json.MarshalIndent(content, "", "  ") //nolint:errcheck // pretty-printing an already-unmarshaled value; re-marshal cannot fail
				return &types.ToolResult{Content: string(formatted)}, nil
			},
		})
	}

	for name, def := range result.Commands {
		cmdName := name // capture for closure
		h.sdk.RegisterCommand(name, CommandDefinition{
			Description: def.Description,
			Execute: func(args string, ctx *Context) error {
				h.ctxStack.Push(ctx)
				defer h.ctxStack.Pop()
				_, err := h.call("command/"+cmdName, map[string]string{"args": args})
				return err
			},
		})
	}

	if len(result.Tools) > 0 || len(result.Commands) > 0 {
		utils.LogWithFields(utils.LevelInfo, "extension", "registered tools and commands from init", map[string]any{"count": len(result.Tools), "max": len(result.Commands)})
	}

	// Stash async-trigger declarations on the host. The session manager
	// commits them through the registry after wiring the lifecycle-hook
	// callback so init-time vetoes can fire. Re-stashing on respawn is
	// safe: the previous subprocess's declarations are gone with it, and
	// the new init payload is the authoritative set.
	if len(result.Webhooks) > 0 || len(result.Schedules) > 0 {
		h.asyncOnce.Do(func() { h.async = &asyncHostState{} })
		h.async.mu.Lock()
		h.pendingInitWebhooks = append([]WebhookRoute(nil), result.Webhooks...)
		h.pendingInitSchedules = append([]ScheduleJob(nil), result.Schedules...)
		h.async.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "extension", "queued init async decls", map[string]any{"model": h.name_(), "count": len(result.Webhooks), "max": len(result.Schedules)})
	}

	// Stash resource declarations for session wiring.
	if len(result.Resources) > 0 {
		h.pendingInitResources = append([]types.ResourceDeclaration(nil), result.Resources...)
		utils.LogWithFields(utils.LevelInfo, "extension", "queued init resource decls", map[string]any{"model": h.name_(), "count": len(result.Resources)})
	}

	return nil
}

// validateBuildIdentity checks the SDK-reported build identity against the
// engine's own. Mismatch (both non-empty, different) is a hard reject. Missing
// (SDK returns empty) is a warning for backward compat with older SDKs.
func (h *Host) validateBuildIdentity(sdkIdentity string) error {
	engineID := h.engineBuildIdentity
	fields := map[string]any{
		"engine_build_identity": engineID,
		"sdk_build_identity":    sdkIdentity,
		"extension":             h.name,
	}

	if engineID == "" || engineID == "dev" {
		utils.LogWithFields(utils.LevelDebug, "extension", "build identity check skipped: development engine build", fields)
		return nil
	}

	if sdkIdentity == "" {
		utils.LogWithFields(utils.LevelWarn, "extension", "SDK did not report build identity; allowing for backward compatibility", fields)
		return nil
	}

	if sdkIdentity != engineID {
		utils.LogWithFields(utils.LevelError, "extension", "build identity mismatch: engine and SDK built from different releases", fields)
		return fmt.Errorf("build identity mismatch: engine=%q sdk=%q", engineID, sdkIdentity)
	}

	utils.LogWithFields(utils.LevelDebug, "extension", "build identity verified", fields)
	return nil
}

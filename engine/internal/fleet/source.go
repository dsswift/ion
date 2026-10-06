package fleet

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ResolveSource reads a deploy's --source: "dev" builds the fleet file's
// checkout, "release" installs the newest published release, and anything
// else is a path to the checkout to build and ship ("." for the current
// folder): a bench, a worktree, any Ion checkout. It returns the source kind
// and the checkout the deploy builds from; a release needs none.
func ResolveSource(source string, cfg Config) (kind, checkout string, err error) {
	switch source {
	case "":
		return "", "", errors.New(`name a source: --source dev, --source release, or --source PATH ("." builds this folder)`)
	case SourceDev:
		if cfg.Checkout == "" {
			return "", "", errors.New("a dev deploy builds from a checkout: name it with `ion fleet checkout PATH`, or pass --source PATH (--source . builds this folder)")
		}
		return SourceDev, cfg.Checkout, IsCheckout(cfg.Checkout)
	case SourceRelease:
		return SourceRelease, "", nil
	}
	if rest, ok := strings.CutPrefix(source, "~"); ok && (rest == "" || strings.HasPrefix(rest, "/")) {
		home, err := utils.UserHomeDir()
		if err != nil {
			return "", "", fmt.Errorf("--source %s: %w", source, err)
		}
		source = home + rest
	}
	dir, err := filepath.Abs(source)
	if err != nil {
		return "", "", fmt.Errorf("--source %s: %w", source, err)
	}
	if err := IsCheckout(dir); err != nil {
		return "", "", err
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy source is a checkout path", map[string]any{"checkout": dir})
	return SourceDev, dir, nil
}

// checkoutMarkers are files every Ion checkout carries at its top folder.
var checkoutMarkers = []string{"scripts/package-studio-server.sh", "scripts/install-studio-server.sh", "engine/go.mod", "desktop/package.json"}

// IsCheckout reports whether dir is an Ion checkout a deploy can build from.
// Each refusal names what is wrong with dir and what to choose instead: a
// folder that is gone (a removed bench or worktree), a file where a folder
// belongs, or a folder that is not the top of an Ion clone.
func IsCheckout(dir string) error {
	info, err := os.Stat(dir)
	switch {
	case errors.Is(err, os.ErrNotExist):
		utils.LogWithFields(utils.LevelDebug, logTag, "deploy checkout missing", map[string]any{"checkout": dir})
		return fmt.Errorf("the checkout %s no longer exists (a removed bench or worktree leaves this behind); choose an Ion clone, worktree, or bench that is still on disk", dir)
	case err != nil:
		utils.LogWithFields(utils.LevelDebug, logTag, "deploy checkout unreadable", map[string]any{"checkout": dir, "error": err.Error()})
		return fmt.Errorf("the checkout %s cannot be read: %w", dir, err)
	case !info.IsDir():
		utils.LogWithFields(utils.LevelDebug, logTag, "deploy checkout is a file", map[string]any{"checkout": dir})
		return fmt.Errorf("the checkout %s is a file; choose the top folder of an Ion clone, worktree, or bench", dir)
	}
	for _, rel := range checkoutMarkers {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			utils.LogWithFields(utils.LevelDebug, logTag, "deploy checkout lacks a marker file", map[string]any{"checkout": dir, "missing": rel})
			return fmt.Errorf("%s is not the top folder of an Ion checkout: every Ion clone has %s, and this folder does not; choose the folder that holds Ion's source (a clone, a worktree, or a bench), not a folder inside it or a different project", dir, rel)
		}
	}
	return nil
}

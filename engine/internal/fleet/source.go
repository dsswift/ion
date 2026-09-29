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
			return "", "", errors.New(`a dev deploy builds from a checkout: set "checkout" in ~/.ion/fleet.json, or pass --source PATH (--source . builds this folder)`)
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

// IsCheckout reports whether dir is an Ion checkout a deploy can build from.
func IsCheckout(dir string) error {
	for _, rel := range []string{"scripts/package-studio-server.sh", "scripts/install-studio-server.sh", "engine/go.mod", "desktop/package.json"} {
		if _, err := os.Stat(filepath.Join(dir, rel)); err != nil {
			return fmt.Errorf("%s is not an Ion checkout (no %s)", dir, rel)
		}
	}
	return nil
}

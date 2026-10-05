package fleet

import (
	"encoding/json"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"testing"
)

// `npm ci` on a builder host runs the root package's lifecycle scripts, so
// every file one of them names must be in what the fleet ships. A script
// that points at a folder buildRoots leaves behind fails the build there.
func TestBuildRoots_ShipWhatTheRootInstallScriptsRun(t *testing.T) {
	raw, err := os.ReadFile(filepath.Join("..", "..", "..", "package.json"))
	if err != nil {
		t.Skipf("no root package.json beside the engine: %v", err)
	}
	var pkg struct {
		Scripts map[string]string `json:"scripts"`
	}
	if err := json.Unmarshal(raw, &pkg); err != nil {
		t.Fatal(err)
	}
	shipped := map[string]bool{}
	for _, root := range buildRoots {
		shipped[root] = true
	}
	file := regexp.MustCompile(`[\w.\-]+(?:/[\w.\-]+)+`)
	for _, name := range []string{"preinstall", "install", "postinstall", "prepare"} {
		for _, path := range file.FindAllString(pkg.Scripts[name], -1) {
			if top := strings.SplitN(path, "/", 2)[0]; !shipped[top] {
				t.Errorf("the root %q script runs %s, but buildRoots does not ship %q", name, path, top)
			}
		}
	}
}

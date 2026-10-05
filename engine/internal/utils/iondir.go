package utils

import (
	"os"
	"path/filepath"
)

// IonDir returns the root data directory for this engine instance.
//
// When ION_DATA_DIR is set in the environment it is returned verbatim (no
// expansion, no join) so that multiple engine instances -- a container, a
// second engine on one machine, a test harness -- can each claim an
// independent data root without colliding on ~/.ion. When unset, the
// conventional <home>/.ion path is returned, using UserHomeDir so HOME-based
// test isolation works identically on every platform including Windows.
//
// Every path under the engine's data root -- conversations, session
// bindings, install_id, engine.json, settings.json, worktree-registry.json,
// logs, spool, plugins, MCP stores, skills, plan directories -- derives from
// this single resolver. A test (TestNoStrayIonJoins) walks the engine tree
// and fails on any new ".ion" join outside this file, so a future call site
// cannot silently reintroduce a second source of truth for the data root.
//
// IonDir is deliberately silent: it is called from inside initLogger()
// itself (resolving the default log directory on the first lazy log write),
// and a log call made from there would try to re-enter the non-reentrant
// logMu mutex that initLogger already holds and deadlock the process. The
// one INFO "data dir resolved" log the specification calls for is instead
// emitted once, synchronously, from the real process-startup call site in
// cmd_serve.go -- outside any logger-internal lock -- via IonDirSource.
func IonDir() string {
	if v := os.Getenv("ION_DATA_DIR"); v != "" {
		return v
	}
	home, err := UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".ion")
}

// HomeIonDir returns <home>/.ion, ignoring ION_DATA_DIR. It is for the few
// files another Ion process keeps pinned to the home directory whatever data
// root this engine runs with, so the engine reads them where that process
// writes them. It returns "" when no home directory resolves.
func HomeIonDir() string {
	home, err := UserHomeDir()
	if err != nil || home == "" {
		return ""
	}
	return filepath.Join(home, ".ion")
}

// IonDirSource reports which branch IonDir() took: "env" when ION_DATA_DIR
// is set, "home" otherwise. Startup call sites use this alongside IonDir()
// to log the one-shot "data dir resolved" line without duplicating the
// resolver's own branching.
func IonDirSource() string {
	if os.Getenv("ION_DATA_DIR") != "" {
		return "env"
	}
	return "home"
}

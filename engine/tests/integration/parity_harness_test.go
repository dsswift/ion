//go:build integration

// parity_harness_test.go — builds and locates both canary variants.
//
// The parity suite runs each scenario twice, once against the TypeScript
// canary and once against the Go one, then compares the two observations. This
// file provides the variants: an entry path for the TS canary (esbuild + node,
// the normal extension path) and a compiled binary for the Go one.
//
// The Go binary is built once per test binary rather than per test. A go build
// is a couple of seconds; paying it for every scenario would make the suite
// slow enough that someone eventually skips it.

package integration

import (
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
)

// requireGo skips when no Go toolchain is available. Analogous to
// requireEsbuild: the suite is meaningful only when both variants can run, and
// a skip is more useful than a failure on a machine that cannot build one.
func requireGo(t *testing.T) {
	t.Helper()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("go toolchain not on PATH, skipping the Go canary variant")
	}
}

var (
	goCanaryOnce sync.Once
	goCanaryDir  string
	goCanaryErr  error
)

// goCanaryBinary builds the Go canary and returns the directory holding the
// resulting binary, named main.
//
// Returning the *directory* is deliberate: loading by directory is what
// exercises the entry-point resolution fix, so the suite covers it with a real
// compiled binary as a side effect of running at all.
func goCanaryBinary(t *testing.T) string {
	t.Helper()
	requireGo(t)

	goCanaryOnce.Do(func() {
		srcDir, err := filepath.Abs(filepath.Join("..", "..", "extensions", "go-canary"))
		if err != nil {
			goCanaryErr = err
			return
		}

		// A stable build directory outside the source tree: the binary must
		// be the only entry-point candidate in it, and dropping a compiled
		// main into the source directory would leave main.go beside it.
		outDir, err := os.MkdirTemp("", "go-canary-build")
		if err != nil {
			goCanaryErr = err
			return
		}

		cmd := exec.Command("go", "build", "-o", filepath.Join(outDir, "main"), ".")
		cmd.Dir = srcDir
		if out, err := cmd.CombinedOutput(); err != nil {
			goCanaryErr = &buildError{output: string(out), err: err}
			return
		}
		goCanaryDir = outDir
	})

	if goCanaryErr != nil {
		t.Fatalf("build go-canary: %v", goCanaryErr)
	}
	return goCanaryDir
}

type buildError struct {
	output string
	err    error
}

func (e *buildError) Error() string { return e.err.Error() + "\n" + e.output }

// parityCanaryEntry resolves the TypeScript canary's entry point.
func parityCanaryEntry(t *testing.T) string {
	t.Helper()
	abs, err := filepath.Abs(filepath.Join("..", "..", "extensions", "parity-canary", "index.ts"))
	if err != nil {
		t.Fatalf("resolve parity-canary path: %v", err)
	}
	if _, err := os.Stat(abs); err != nil {
		t.Fatalf("parity-canary entry point missing at %s: %v", abs, err)
	}
	return abs
}

// canaryVariant is one language's build of the canary.
type canaryVariant struct {
	// Name identifies the variant in subtest output.
	Name string
	// LoadPath is what Host.Load is given: a file for the TS canary, a
	// directory for the Go one.
	LoadPath string
	// ExtDir is the extension directory for ExtensionConfig.
	ExtDir string
}

// canaryVariants returns both builds. The TS variant needs esbuild, the Go one
// needs a toolchain; each skips independently through its require helper, so a
// machine missing one still exercises the other.
func canaryVariants(t *testing.T) []canaryVariant {
	t.Helper()

	requireEsbuild(t)
	tsEntry := parityCanaryEntry(t)

	goDir := goCanaryBinary(t)

	return []canaryVariant{
		{Name: "typescript", LoadPath: tsEntry, ExtDir: filepath.Dir(tsEntry)},
		{Name: "go", LoadPath: goDir, ExtDir: goDir},
	}
}

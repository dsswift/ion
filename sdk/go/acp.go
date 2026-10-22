// acp.go — a harness binary served as its own ACP agent.
//
// The engine spawns an extension binary with no arguments. Run with the single
// argument `acp` instead (`main acp`), the same binary is an Agent Client
// Protocol agent: [New] replaces the process with `ion acp --harness <dir>`,
// which serves this extension, and only this extension, to the ACP client
// that launched it. An ACP client (T3 Code, Zed, any ACP editor) therefore
// lists the harness as an agent in its own right, launched by its own path.
//
// The hand-off happens inside New, before any registration or log line, so
// nothing the extension does can write into the ACP stream.
package ion

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
)

// ACPCommand is the argument that runs an extension binary as its own ACP
// agent.
const ACPCommand = "acp"

// EngineBinaryEnv names the engine binary the ACP hand-off runs. Unset, the
// hand-off uses ~/.ion/bin/ion, then `ion` on PATH.
const EngineBinaryEnv = "ION_ENGINE_BINARY"

// WithTitle sets the title an ACP client shows for this extension when it
// runs as its own agent ([ACPCommand]). Unset, the client shows the
// extension's manifest name.
func WithTitle(title string) Option {
	return func(s *SDK) { s.title = title }
}

// acpLaunch is the engine invocation that serves the extension at exe as an
// ACP agent: `<engine> acp --harness <exe's directory> [--title T] [rest]`,
// where rest is everything after the `acp` argument (for example --model).
func acpLaunch(engine, exe, title string, rest []string) []string {
	argv := []string{engine, ACPCommand, "--harness", filepath.Dir(exe)}
	if title != "" {
		argv = append(argv, "--title", title)
	}
	return append(argv, rest...)
}

// engineBinary finds the engine to hand off to.
func engineBinary() (string, error) {
	if bin := os.Getenv(EngineBinaryEnv); bin != "" {
		return bin, nil
	}
	if home, err := os.UserHomeDir(); err == nil {
		bin := filepath.Join(home, ".ion", "bin", "ion")
		if info, err := os.Stat(bin); err == nil && !info.IsDir() {
			return bin, nil
		}
	}
	bin, err := exec.LookPath("ion")
	if err != nil {
		return "", errors.New("no Ion engine found: install it to ~/.ion/bin/ion, put ion on PATH, or set " + EngineBinaryEnv)
	}
	return bin, nil
}

// serveACP replaces this process with the engine's ACP agent for this
// extension. It returns only on failure, which it reports on stderr (the
// channel an ACP client shows for a failed start) before exiting.
func (s *SDK) serveACP() {
	exe, err := os.Executable()
	if err == nil {
		exe, err = filepath.EvalSymlinks(exe)
	}
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s acp: locate this binary: %v\n", s.name, err)
		os.Exit(1)
	}
	engine, err := engineBinary()
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s acp: %v\n", s.name, err)
		os.Exit(1)
	}
	argv := acpLaunch(engine, exe, s.title, os.Args[2:])
	code, err := execEngine(argv)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%s acp: run %s: %v\n", s.name, engine, err)
		os.Exit(1)
	}
	os.Exit(code)
}

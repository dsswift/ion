package main

import (
	"os"
	"path/filepath"
	"strings"
)

// boolFlags lists flags that never consume the next argument as a value.
var boolFlags = map[string]bool{
	"no-extensions": true,
	"attach":        true,
	"no-browser":    true,
}

// multiFlags lists flags that can be specified multiple times.
// header/env/arg carry `ion mcp add` server definitions (one HTTP header,
// environment variable, or stdio argument per occurrence).
var multiFlags = map[string]bool{
	"extension": true,
	"header":    true,
	"env":       true,
	"arg":       true,
}

// infoFlags maps a bare flag that acts as a COMMAND to the command it names.
//
// These are the conventional CLI spellings an operator (or a Makefile, or a
// shell completion probe) reaches for to ask the binary a question about
// itself. They must never be treated as options to the default command.
//
// Without this, `ion --version` fell into the `strings.HasPrefix(args[0], "--")`
// branch below and resolved to "serve" — so asking for a version string booted
// the whole daemon path: it created ~/.ion, logged an `=== engine process
// start ===` line, wrote an exit breadcrumb, loaded config, and reconciled
// plugins before the file lock finally refused it and the process died. On a
// machine with a healthy daemon that produced an endless stream of start lines
// and `prior exit: UNCLEAN` breadcrumbs, which is indistinguishable in the log
// from a genuine crash loop. cos2's Makefile calls `ion version` on every
// build, so the noise was continuous and self-inflicted.
var infoFlags = map[string]string{
	"version": "version",
	"help":    "help",
}

// shortFlagAliases maps single-dash shorthands to the same commands. `-v` and
// `-h` are near-universal CLI conventions; before this they fell through to the
// default branch and were passed as an unknown COMMAND named "-v", which
// printed usage and exited 1 rather than answering the question.
var shortFlagAliases = map[string]string{
	"-v": "version",
	"-h": "help",
}

// parseArgs extracts command, flags, list flags, and positional args from os.Args.
func parseArgs() (command string, flags map[string]string, listFlags map[string][]string, positional []string) {
	args := os.Args[1:]
	flags = make(map[string]string)
	listFlags = make(map[string][]string)

	switch {
	case len(args) == 0:
		command = "serve"
	case infoFlags[strings.TrimPrefix(args[0], "--")] != "" && strings.HasPrefix(args[0], "--"):
		// `ion --version` / `ion --help`: a question about the binary, not an
		// option to the daemon. Resolved before the serve default so it never
		// reaches cmdServe.
		command = infoFlags[strings.TrimPrefix(args[0], "--")]
		args = args[1:]
	case shortFlagAliases[args[0]] != "":
		command = shortFlagAliases[args[0]]
		args = args[1:]
	case strings.HasPrefix(args[0], "--"):
		command = "serve"
	default:
		command = args[0]
		args = args[1:]
	}

	for i := 0; i < len(args); i++ {
		if strings.HasPrefix(args[i], "--") {
			key := strings.TrimPrefix(args[i], "--")
			if boolFlags[key] {
				flags[key] = "true"
			} else if i+1 < len(args) && !strings.HasPrefix(args[i+1], "--") {
				val := args[i+1]
				if multiFlags[key] {
					listFlags[key] = append(listFlags[key], val)
				}
				flags[key] = val
				i++
			} else {
				flags[key] = "true"
			}
		} else {
			positional = append(positional, args[i])
		}
	}
	return
}

// isEnvVarName returns true if s looks like an environment variable name
// (all uppercase letters, digits, and underscores, at least 3 chars).
func isEnvVarName(s string) bool {
	if len(s) < 3 {
		return false
	}
	for _, c := range s {
		isUpper := c >= 'A' && c <= 'Z'
		isDigit := c >= '0' && c <= '9'
		isUnder := c == '_'
		if !isUpper && !isDigit && !isUnder {
			return false
		}
	}
	return true
}

// resolveExtensionPath expands ~ and resolves to an absolute path.
func resolveExtensionPath(path string) string {
	if strings.HasPrefix(path, "~") {
		home, err := os.UserHomeDir()
		if err == nil {
			path = filepath.Join(home, path[1:])
		}
	}
	abs, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	return abs
}

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
}

// multiFlags lists flags that can be specified multiple times.
var multiFlags = map[string]bool{"extension": true}

// parseArgs extracts command, flags, list flags, and positional args from os.Args.
func parseArgs() (command string, flags map[string]string, listFlags map[string][]string, positional []string) {
	args := os.Args[1:]
	flags = make(map[string]string)
	listFlags = make(map[string][]string)

	if len(args) == 0 || strings.HasPrefix(args[0], "--") {
		command = "serve"
	} else {
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
		if !((c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
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

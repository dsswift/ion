package permissions

import "strings"

// safeBashCommands lists commands that are safe to execute without permission prompts.
var safeBashCommands = map[string]bool{
	// File listing and info
	"ls": true, "ll": true, "la": true, "dir": true,
	"stat": true, "file": true, "wc": true,
	"du": true, "df": true,

	// File reading
	"cat": true, "head": true, "tail": true, "less": true, "more": true,

	// Search
	"find": true, "grep": true, "rg": true, "ag": true,
	"which": true, "where": true, "whereis": true, "type": true,

	// Text processing (read-only)
	"sort": true, "uniq": true, "cut": true, "tr": true,
	"awk": true, "sed": true, // note: sed can modify files with -i
	"jq": true, "yq": true, "xq": true,
	"diff": true, "comm": true,

	// System info
	"uname": true, "hostname": true, "whoami": true, "id": true,
	"date": true, "cal": true, "uptime": true,
	"env": true, "printenv": true, "echo": true, "printf": true,
	"pwd": true, "realpath": true, "basename": true, "dirname": true,

	// Process info
	"ps": true, "top": true, "htop": true,

	// Network info (read-only)
	"ping": true, "host": true, "dig": true, "nslookup": true,
	"ifconfig": true, "ip": true, "netstat": true, "ss": true,

	// Version/help
	"man": true, "help": true, "info": true,

	// Dev tools (read-only operations)
	"node": true, "python": true, "python3": true, "ruby": true,
	"go": true, "rustc": true, "cargo": true,
	"npm": true, "yarn": true, "pnpm": true, "bun": true,
	"pip": true, "pip3": true, "uv": true,
	"make": true, "cmake": true,

	// Git (read-only subcommands checked separately)
	"git": true,

	// Build tools
	"gcc": true, "g++": true, "clang": true,
	"tsc": true, "esbuild": true, "vite": true, "webpack": true,

	// Test runners
	"jest": true, "vitest": true, "pytest": true, "mocha": true,

	// Container (read-only)
	"docker": true, "kubectl": true,

	// Misc safe
	"tree": true, "bat": true, "exa": true, "fd": true,
	"true": true, "false": true, "test": true,
	"sleep": true, "wait": true,
	"xargs": true, "tee": true,
	"md5sum": true, "sha256sum": true, "shasum": true,
	"base64": true, "xxd": true,
	"tar": true, "zip": true, "unzip": true, "gzip": true, "gunzip": true,
}

// gitMutatingSubcommands are git subcommands that modify state.
var gitMutatingSubcommands = map[string]bool{
	"push": true, "commit": true, "merge": true, "rebase": true,
	"reset": true, "checkout": true, "switch": true, "restore": true,
	"cherry-pick": true, "revert": true, "tag": true,
	"branch": true, "stash": true, "clean": true,
	"rm": true, "mv": true, "add": true,
	"pull": true, "fetch": true, "clone": true, "init": true,
	"submodule": true, "worktree": true,
	"bisect": true, "am": true, "apply": true,
}

// npmMutatingSubcommands are npm/yarn/pnpm subcommands that modify state.
var npmMutatingSubcommands = map[string]bool{
	"install": true, "i": true, "add": true, "remove": true, "rm": true,
	"uninstall": true, "update": true, "upgrade": true,
	"publish": true, "unpublish": true,
	"link": true, "unlink": true,
	"cache": true, "prune": true, "dedupe": true,
	"init": true, "create": true,
	"exec": true, "dlx": true,
	"set": true, "config": true,
}

// dockerMutatingSubcommands are docker subcommands that modify state.
var dockerMutatingSubcommands = map[string]bool{
	"build": true, "push": true, "pull": true, "run": true,
	"exec": true, "stop": true, "kill": true, "rm": true, "rmi": true,
	"create": true, "start": true, "restart": true, "pause": true,
	"unpause": true, "rename": true, "update": true, "commit": true,
	"tag": true, "save": true, "load": true, "import": true, "export": true,
	"network": true, "volume": true, "compose": true, "system": true,
}

// kubectlMutatingSubcommands are kubectl subcommands that modify state.
var kubectlMutatingSubcommands = map[string]bool{
	"apply": true, "create": true, "delete": true, "edit": true,
	"patch": true, "replace": true, "set": true, "scale": true,
	"rollout": true, "expose": true, "run": true, "exec": true,
	"cp": true, "drain": true, "cordon": true, "uncordon": true,
	"taint": true, "label": true, "annotate": true,
}

// IsSafeBashCommand checks if a bash command is safe to auto-approve.
// Returns true if the command and all its subcommands are read-only safe.
func IsSafeBashCommand(cmd string) bool {
	cmd = strings.TrimSpace(cmd)
	if cmd == "" {
		return false
	}

	// Check for redirects (unsafe except /dev/null)
	if hasUnsafeRedirect(cmd) {
		return false
	}

	// Handle pipes: all segments must be safe
	if strings.Contains(cmd, "|") {
		segments := strings.Split(cmd, "|")
		for _, seg := range segments {
			if !isSingleCommandSafe(strings.TrimSpace(seg)) {
				return false
			}
		}
		return true
	}

	// Handle && and ; chains: all segments must be safe
	for _, sep := range []string{"&&", ";"} {
		if strings.Contains(cmd, sep) {
			segments := strings.Split(cmd, sep)
			for _, seg := range segments {
				if !IsSafeBashCommand(strings.TrimSpace(seg)) {
					return false
				}
			}
			return true
		}
	}

	return isSingleCommandSafe(cmd)
}

func isSingleCommandSafe(cmd string) bool {
	// Strip leading env vars (VAR=val cmd ...)
	for strings.Contains(cmd, "=") {
		parts := strings.SplitN(cmd, " ", 2)
		if len(parts) < 2 || !strings.Contains(parts[0], "=") {
			break
		}
		cmd = strings.TrimSpace(parts[1])
	}

	fields := strings.Fields(cmd)
	if len(fields) == 0 {
		return true
	}

	// Strip path prefix (e.g., /usr/bin/git -> git)
	base := fields[0]
	if idx := strings.LastIndex(base, "/"); idx >= 0 {
		base = base[idx+1:]
	}

	if !safeBashCommands[base] {
		return false
	}

	// Check subcommand mutation for specific tools
	if len(fields) > 1 {
		sub := fields[1]
		// Strip leading dashes from subcommand (some tools use --subcommand)
		sub = strings.TrimLeft(sub, "-")

		switch base {
		case "git":
			return !gitMutatingSubcommands[sub]
		case "npm", "yarn", "pnpm", "bun":
			return !npmMutatingSubcommands[sub]
		case "docker":
			return !dockerMutatingSubcommands[sub]
		case "kubectl":
			return !kubectlMutatingSubcommands[sub]
		case "sed":
			// sed -i is mutating
			for _, f := range fields[1:] {
				if f == "-i" || strings.HasPrefix(f, "-i") {
					return false
				}
			}
		}
	}

	return true
}

// hasUnsafeRedirect checks for output redirects that aren't /dev/null.
func hasUnsafeRedirect(cmd string) bool {
	// Look for > that aren't inside quotes
	inSingle := false
	inDouble := false
	for i, c := range cmd {
		switch c {
		case '\'':
			if !inDouble {
				inSingle = !inSingle
			}
		case '"':
			if !inSingle {
				inDouble = !inDouble
			}
		case '>':
			if !inSingle && !inDouble {
				// Skip fd redirects like 2>&1 or >&2 (not output redirects to files)
				if i+1 < len(cmd) && cmd[i+1] == '&' {
					continue
				}
				// Check what follows the redirect
				rest := strings.TrimSpace(cmd[i+1:])
				// >> is append, also check
				if strings.HasPrefix(rest, ">") {
					rest = strings.TrimSpace(rest[1:])
				}
				// Allow redirect to /dev/null only
				target := strings.Fields(rest)
				if len(target) == 0 || target[0] != "/dev/null" {
					return true
				}
			}
		}
	}
	return false
}

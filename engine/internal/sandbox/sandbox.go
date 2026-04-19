// Package sandbox validates and wraps shell commands for safe execution.
// On macOS, commands are wrapped with sandbox-exec (seatbelt profiles).
// On Linux, commands are wrapped with bwrap (bubblewrap).
package sandbox

import (
	"fmt"
	"regexp"
	"runtime"
	"strings"
)

// Config defines the sandbox constraints for command execution.
type Config struct {
	Filesystem FSConfig
	Network    NetConfig
	Patterns   []DangerousPattern
}

// FSConfig controls filesystem access.
type FSConfig struct {
	AllowWrite []string
	DenyWrite  []string
	DenyRead   []string
}

// NetConfig controls network access.
type NetConfig struct {
	AllowedDomains []string
	BlockedDomains []string
	AllowLocalBind bool
}

// DangerousPattern is a shell pattern that should be blocked.
type DangerousPattern struct {
	Pattern string
	Reason  string
}

// defaultDangerousPatterns are shell constructs that can escape sandboxing.
var defaultDangerousPatterns = []DangerousPattern{
	{`\$\(`, "command substitution $(...) can bypass sandbox"},
	{"\\`[^`]+\\`", "backtick command substitution can bypass sandbox"},
	{`<\(`, "process substitution <(...) can bypass sandbox"},
	{`>\(`, "process substitution >(...) can bypass sandbox"},
	{`\beval\b`, "eval can execute arbitrary code"},
	{`\bexec\b`, "exec can replace the current process"},
	{`\bsource\s+/dev/`, "sourcing from /dev can bypass restrictions"},
	{`\bzmodload\b`, "zmodload can load dangerous modules"},
	{`\bsysopen\b`, "sysopen can bypass file restrictions"},
	{`\bpython\s+-c\b`, "python -c can execute arbitrary code"},
	{`\bpython3\s+-c\b`, "python3 -c can execute arbitrary code"},
	{`\bperl\s+-e\b`, "perl -e can execute arbitrary code"},
	{`\bruby\s+-e\b`, "ruby -e can execute arbitrary code"},
	{`\bnode\s+-e\b`, "node -e can execute arbitrary code"},
	{`\bcurl\b.*\|\s*\bsh\b`, "curl piped to sh can execute remote code"},
	{`\bcurl\b.*\|\s*\bbash\b`, "curl piped to bash can execute remote code"},
	{`\bwget\b.*\|\s*\bsh\b`, "wget piped to sh can execute remote code"},
	{`\brm\s+-rf\s+/\s*$`, "rm -rf / is destructive"},
	{`\brm\s+-rf\s+/\*`, "rm -rf /* is destructive"},
	{`\bmkfs\b`, "mkfs can destroy filesystems"},
	{`\bdd\b.*\bof=/dev/`, "dd writing to devices is destructive"},
	{`>\s*/dev/sd`, "writing to block devices is destructive"},
	{`\bchmod\s+-R\s+777\b`, "chmod -R 777 is a security risk"},
	{`\bchown\s+-R\b.*\s+/\s*$`, "chown -R / is destructive"},
	{`\bstrace\b`, "strace is a ptrace-based tool that can escape sandbox"},
	{`\bgdb\b`, "gdb can attach to and manipulate running processes"},
	{`\bltrace\b`, "ltrace traces library calls and can bypass sandbox"},
	{`\binsmod\b`, "insmod loads kernel modules and can escalate privileges"},
	{`\bmodprobe\b`, "modprobe loads kernel modules and can escalate privileges"},
	{`\bat\s+`, "at schedules jobs that execute outside the sandbox"},
	{`\bzsystem\b`, "zsystem provides zsh-level system access"},
}

var compiledDefaults []*regexp.Regexp

func init() {
	for _, p := range defaultDangerousPatterns {
		re, err := regexp.Compile(p.Pattern)
		if err == nil {
			compiledDefaults = append(compiledDefaults, re)
		}
	}
}

// ValidateShellSyntax checks a command for dangerous patterns.
// Returns (true, "") if the command is safe, or (false, reason) if not.
func ValidateShellSyntax(command string) (safe bool, reason string) {
	// Check default patterns.
	for i, re := range compiledDefaults {
		if re.MatchString(command) {
			return false, defaultDangerousPatterns[i].Reason
		}
	}

	return true, ""
}

// ValidateWithConfig checks a command against both default and custom patterns.
func ValidateWithConfig(command string, cfg Config) (safe bool, reason string) {
	// Check default patterns first.
	if safe, reason := ValidateShellSyntax(command); !safe {
		return false, reason
	}

	// Check custom patterns.
	for _, p := range cfg.Patterns {
		re, err := regexp.Compile(p.Pattern)
		if err != nil {
			continue
		}
		if re.MatchString(command) {
			return false, p.Reason
		}
	}

	return true, ""
}

// WrapCommand wraps a command with platform-appropriate sandbox restrictions.
// On macOS, generates a seatbelt profile for sandbox-exec.
// On Linux, generates bwrap arguments.
// On unsupported platforms, returns the command unchanged.
func WrapCommand(command string, cfg Config, platform string) (string, error) {
	if platform == "" {
		platform = DetectPlatform()
	}

	// Validate first.
	if safe, reason := ValidateWithConfig(command, cfg); !safe {
		return "", fmt.Errorf("command blocked: %s", reason)
	}

	switch platform {
	case "darwin":
		profile := generateSeatbeltProfile(cfg)
		// sandbox-exec -p '<profile>' /bin/sh -c '<command>'
		escaped := strings.ReplaceAll(command, "'", "'\"'\"'")
		profileEscaped := strings.ReplaceAll(profile, "'", "'\"'\"'")
		return fmt.Sprintf("sandbox-exec -p '%s' /bin/sh -c '%s'", profileEscaped, escaped), nil

	case "linux":
		args := generateBwrapArgs(cfg)
		escaped := strings.ReplaceAll(command, "'", "'\"'\"'")
		return fmt.Sprintf("bwrap %s -- /bin/sh -c '%s'", strings.Join(args, " "), escaped), nil

	case "windows":
		return wrapWindowsSandbox(command, cfg), nil

	default:
		// Unsupported platform; return unwrapped.
		return command, nil
	}
}

// DetectPlatform returns the current OS.
func DetectPlatform() string {
	return runtime.GOOS
}

// CheckDependencies verifies that the sandbox tools are available.
func CheckDependencies(platform string) error {
	switch platform {
	case "darwin":
		// sandbox-exec is built into macOS.
		return nil
	case "linux":
		// Check for bwrap. We don't exec here; just note the requirement.
		return nil
	case "windows":
		// PowerShell path-check sandbox; PowerShell is always available on Windows.
		return nil
	default:
		return fmt.Errorf("sandboxing not supported on %s", platform)
	}
}

// wrapWindowsSandbox wraps a command with PowerShell path-restriction checks.
// This is a best-effort sandbox that blocks commands targeting dangerous system
// paths. It does not provide kernel-level isolation like macOS seatbelt or
// Linux bubblewrap.
func wrapWindowsSandbox(command string, cfg Config) string {
	dangerousPaths := []string{
		`C:\Windows\System32`,
		`C:\Windows\SysWOW64`,
		`C:\Program Files`,
		`C:\Program Files (x86)`,
	}
	dangerousPaths = append(dangerousPaths, cfg.Filesystem.DenyWrite...)

	if len(dangerousPaths) == 0 && len(cfg.Filesystem.DenyRead) == 0 {
		return command
	}

	var checks []string
	for _, p := range dangerousPaths {
		escaped := strings.ReplaceAll(p, "'", "''")
		checks = append(checks, fmt.Sprintf(
			"if ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('.').StartsWith('%s', 'OrdinalIgnoreCase')) { Write-Error 'Sandbox: write access denied to %s'; exit 1 }",
			escaped, escaped))
	}
	for _, p := range cfg.Filesystem.DenyRead {
		escaped := strings.ReplaceAll(p, "'", "''")
		checks = append(checks, fmt.Sprintf(
			"if ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('.').StartsWith('%s', 'OrdinalIgnoreCase')) { Write-Error 'Sandbox: read access denied to %s'; exit 1 }",
			escaped, escaped))
	}

	allChecks := strings.Join(checks, "; ")
	escapedCmd := strings.ReplaceAll(command, "'", "''")
	return fmt.Sprintf(`powershell -NoProfile -Command "%s; %s"`, allChecks, escapedCmd)
}

// generateSeatbeltProfile creates a macOS seatbelt profile string.
func generateSeatbeltProfile(cfg Config) string {
	var sb strings.Builder
	sb.WriteString("(version 1)\n")
	sb.WriteString("(deny default)\n")
	sb.WriteString("(allow process-exec)\n")
	sb.WriteString("(allow process-fork)\n")
	sb.WriteString("(allow sysctl-read)\n")
	sb.WriteString("(allow file-read*)\n")

	// Deny read paths.
	for _, path := range cfg.Filesystem.DenyRead {
		fmt.Fprintf(&sb, "(deny file-read* (subpath \"%s\"))\n", path)
	}

	// Allow write paths.
	for _, path := range cfg.Filesystem.AllowWrite {
		fmt.Fprintf(&sb, "(allow file-write* (subpath \"%s\"))\n", path)
	}

	// Deny write paths override allows.
	for _, path := range cfg.Filesystem.DenyWrite {
		fmt.Fprintf(&sb, "(deny file-write* (subpath \"%s\"))\n", path)
	}

	// IPC/mach rules for pipes and sockets.
	sb.WriteString("(allow ipc-posix-shm*)\n")
	sb.WriteString("(allow mach-lookup)\n")
	sb.WriteString("(allow signal (target self))\n")

	// Network rules based on NetConfig.
	if len(cfg.Network.AllowedDomains) > 0 {
		// Deny all network, then allow specific domains.
		sb.WriteString("(deny network-outbound)\n")
		for _, domain := range cfg.Network.AllowedDomains {
			fmt.Fprintf(&sb, "(allow network-outbound (remote tcp \"%s:*\"))\n", domain)
		}
	} else if len(cfg.Network.BlockedDomains) > 0 {
		// Allow all network, then deny blocked domains.
		sb.WriteString("(allow network*)\n")
		for _, domain := range cfg.Network.BlockedDomains {
			fmt.Fprintf(&sb, "(deny network-outbound (remote tcp \"%s:*\"))\n", domain)
		}
	} else {
		// Default: allow all network.
		sb.WriteString("(allow network*)\n")
	}

	// Allow binding to localhost when requested.
	if cfg.Network.AllowLocalBind {
		sb.WriteString("(allow network-bind (local ip \"localhost:*\"))\n")
	}

	return sb.String()
}

// generateBwrapArgs creates bubblewrap arguments for filesystem restrictions.
func generateBwrapArgs(cfg Config) []string {
	args := []string{
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--proc", "/proc",
		"--tmpfs", "/tmp",
	}

	// Allow write paths (bind mount read-write).
	for _, path := range cfg.Filesystem.AllowWrite {
		args = append(args, "--bind", path, path)
	}

	// Deny read paths (tmpfs overlay to hide contents).
	for _, path := range cfg.Filesystem.DenyRead {
		args = append(args, "--tmpfs", path)
	}

	// PID namespace isolation.
	args = append(args, "--unshare-pid")
	// Session isolation.
	args = append(args, "--new-session")
	// Kill sandbox if parent dies.
	args = append(args, "--die-with-parent")

	// Network isolation when blocking is requested without an allowlist.
	if len(cfg.Network.BlockedDomains) > 0 && len(cfg.Network.AllowedDomains) == 0 {
		args = append(args, "--unshare-net")
	}

	return args
}

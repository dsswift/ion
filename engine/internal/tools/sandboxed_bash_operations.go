package tools

import (
	"context"
	"fmt"
	"regexp"
	"runtime"
	"strings"
)

// SandboxConfig configures the sandboxed execution environment.
type SandboxConfig struct {
	Filesystem FSConfig
	Network    NetConfig
	Patterns   []DangerousPattern
	Platform   string // "darwin" or "linux"; auto-detected if empty
}

// FSConfig controls filesystem access in the sandbox.
type FSConfig struct {
	AllowWrite []string
	DenyWrite  []string
	DenyRead   []string
}

// NetConfig controls network access in the sandbox.
type NetConfig struct {
	AllowedDomains []string
	BlockedDomains []string
}

// DangerousPattern is a regex pattern that blocks command execution.
type DangerousPattern struct {
	Pattern string
	Reason  string
}

// SandboxedBashOperations wraps another BashOperations with command
// validation and OS-level sandboxing (macOS: sandbox-exec, Linux: bubblewrap).
type SandboxedBashOperations struct {
	Inner  BashOperations
	Config SandboxConfig
}

func (s *SandboxedBashOperations) Exec(ctx context.Context, command, cwd string, opts ExecOptions) (*ExecResult, error) {
	// Validate against dangerous patterns.
	for _, p := range s.Config.Patterns {
		re, err := regexp.Compile(p.Pattern)
		if err != nil {
			continue
		}
		if re.MatchString(command) {
			return &ExecResult{
				ExitCode: 1,
				Stderr:   fmt.Sprintf("Sandbox: command blocked by policy. %s", p.Reason),
			}, nil
		}
	}

	platform := s.Config.Platform
	if platform == "" {
		platform = runtime.GOOS
	}

	// Wrap command with platform-specific sandbox.
	wrapped := s.wrapCommand(command, cwd, platform)

	return s.Inner.Exec(ctx, wrapped, cwd, opts)
}

func (s *SandboxedBashOperations) wrapCommand(command, cwd, platform string) string {
	switch platform {
	case "darwin":
		return s.wrapDarwin(command, cwd)
	case "linux":
		return s.wrapLinux(command, cwd)
	case "windows":
		return s.wrapWindows(command, cwd)
	default:
		// No sandbox available; pass through.
		return command
	}
}

// wrapDarwin wraps with macOS sandbox-exec (Seatbelt).
func (s *SandboxedBashOperations) wrapDarwin(command, cwd string) string {
	// Build a minimal seatbelt profile.
	var profile strings.Builder
	profile.WriteString("(version 1)\n")
	profile.WriteString("(deny default)\n")
	profile.WriteString("(allow process-exec)\n")
	profile.WriteString("(allow process-fork)\n")
	profile.WriteString("(allow sysctl-read)\n")
	profile.WriteString("(allow mach-lookup)\n")

	// Read access: allow everything except denied paths.
	profile.WriteString("(allow file-read*)\n")
	for _, p := range s.Config.Filesystem.DenyRead {
		fmt.Fprintf(&profile, "(deny file-read* (subpath %q))\n", p)
	}

	// Write access: allow cwd and explicit paths.
	allowWrite := append([]string{cwd, "/dev", "/tmp"}, s.Config.Filesystem.AllowWrite...)
	for _, p := range allowWrite {
		fmt.Fprintf(&profile, "(allow file-write* (subpath %q))\n", p)
	}
	for _, p := range s.Config.Filesystem.DenyWrite {
		fmt.Fprintf(&profile, "(deny file-write* (subpath %q))\n", p)
	}

	// Network.
	if len(s.Config.Network.AllowedDomains) > 0 || len(s.Config.Network.BlockedDomains) == 0 {
		profile.WriteString("(allow network*)\n")
	}

	escaped := strings.ReplaceAll(profile.String(), "'", "'\\''")
	return fmt.Sprintf("sandbox-exec -p '%s' bash -c '%s'",
		escaped, strings.ReplaceAll(command, "'", "'\\''"))
}

// wrapWindows wraps with PowerShell path-restriction checks.
func (s *SandboxedBashOperations) wrapWindows(command, cwd string) string {
	dangerousPaths := []string{
		`C:\Windows\System32`,
		`C:\Windows\SysWOW64`,
		`C:\Program Files`,
		`C:\Program Files (x86)`,
	}
	dangerousPaths = append(dangerousPaths, s.Config.Filesystem.DenyWrite...)

	if len(dangerousPaths) == 0 && len(s.Config.Filesystem.DenyRead) == 0 {
		return command
	}

	var checks []string
	for _, p := range dangerousPaths {
		escaped := strings.ReplaceAll(p, "'", "''")
		checks = append(checks, fmt.Sprintf(
			"if ($ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath('.').StartsWith('%s', 'OrdinalIgnoreCase')) { Write-Error 'Sandbox: write denied to %s'; exit 1 }",
			escaped, escaped))
	}

	allChecks := strings.Join(checks, "; ")
	escapedCmd := strings.ReplaceAll(command, "'", "''")
	return fmt.Sprintf(`powershell -NoProfile -Command "%s; %s"`, allChecks, escapedCmd)
}

// wrapLinux wraps with bubblewrap (bwrap).
func (s *SandboxedBashOperations) wrapLinux(command, cwd string) string {
	args := []string{
		"bwrap",
		"--ro-bind", "/", "/",
		"--dev", "/dev",
		"--tmpfs", "/tmp",
		"--bind", cwd, cwd,
	}

	for _, p := range s.Config.Filesystem.AllowWrite {
		args = append(args, "--bind", p, p)
	}

	if len(s.Config.Network.BlockedDomains) > 0 {
		args = append(args, "--unshare-net")
	}

	args = append(args, "--", "bash", "-c", command)

	return strings.Join(args, " ")
}

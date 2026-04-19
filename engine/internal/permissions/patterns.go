package permissions

import (
	"path/filepath"
	"regexp"
	"strings"
)

// MatchPattern performs glob matching of a pattern against a value.
// Supports *, **, and ? wildcards via filepath.Match.
// For paths containing **, it splits and matches segments.
func MatchPattern(pattern, value string) bool {
	// Handle ** (doublestar) for recursive path matching
	if strings.Contains(pattern, "**") {
		return matchDoublestar(pattern, value)
	}

	matched, err := filepath.Match(pattern, value)
	if err != nil {
		return false
	}
	return matched
}

// matchDoublestar handles ** glob patterns by expanding them.
func matchDoublestar(pattern, value string) bool {
	// Split pattern on **
	parts := strings.SplitN(pattern, "**", 2)
	prefix := parts[0]
	suffix := ""
	if len(parts) > 1 {
		suffix = parts[1]
	}

	// Prefix must match the beginning
	if prefix != "" && !strings.HasPrefix(value, prefix) {
		return false
	}

	// Suffix must match the end
	if suffix != "" {
		// Remove leading separator from suffix
		suffix = strings.TrimPrefix(suffix, "/")
		remaining := strings.TrimPrefix(value, prefix)
		// Check if any suffix of remaining matches the suffix pattern
		segments := strings.Split(remaining, "/")
		for i := range segments {
			candidate := strings.Join(segments[i:], "/")
			if matched, _ := filepath.Match(suffix, candidate); matched {
				return true
			}
			// Also try matching just the last segment
		}
		// Try matching the full remaining against the suffix
		if matched, _ := filepath.Match(suffix, remaining); matched {
			return true
		}
		return false
	}

	return true
}

// dangerousLiteral pairs a literal substring with its reason.
type dangerousLiteral struct {
	pattern string
	reason  string
}

// dangerousRegex pairs a compiled regex with its reason.
type dangerousRegex struct {
	re     *regexp.Regexp
	reason string
}

// literalPatterns are checked via strings.Contains on the normalized command.
var literalPatterns = []dangerousLiteral{
	{"rm -rf /", "recursive delete of root filesystem"},
	{"rm -rf /*", "recursive delete of root filesystem"},
	{"rm -rf ~", "recursive delete of home directory"},
	{"rm -rf ~/*", "recursive delete of home directory"},
	{"rm -fr /", "recursive delete of root filesystem"},
	{"rm -fr ~", "recursive delete of home directory"},
	{"curl|sh", "piped remote execution"},
	{"curl|bash", "piped remote execution"},
	{"wget|sh", "piped remote execution"},
	{"wget|bash", "piped remote execution"},
	{"eval ", "arbitrary code evaluation"},
	{"> /dev/sda", "direct disk write"},
	{"mkfs.", "filesystem format"},
	{":(){:|:&};:", "fork bomb"},
	{"mv / ", "move root filesystem"},
	{"chmod 000 /", "remove all permissions from root"},
	{"kill -9 -1", "killing all user processes"},
	{"killall", "killing processes by name"},
	{"crontab", "modifying scheduled tasks"},
	{"curl --upload-file", "data exfiltration"},
	{"curl -T ", "data exfiltration"},
	{"wget --post-file", "data exfiltration"},
}

// regexPatterns use regex for cases where literal matching causes evasion.
var regexPatterns []dangerousRegex

func init() {
	defs := []struct {
		pattern string
		reason  string
	}{
		// G78: rm with any flag combination containing -r (rm -r, rm -Rf, rm -rv, rm --recursive, etc.)
		{`\brm\s+(-[^\s]*r[^\s]*\s|--recursive\b)`, "recursive delete"},
		// G79: cat reading sensitive files at any path (not just tilde form)
		{`\bcat\s+.*\.aws/credentials`, "reading AWS credentials"},
		{`\bcat\s+.*\.ssh/id_`, "reading SSH private key"},
		{`\bcat\s+.*\.env\b`, "reading environment secrets"},
		// G37: chmod with octal prefix (chmod 0777, chmod 4777, chmod 777)
		{`\bchmod\s+(?:-R\s+)?[0-7]*777\b`, "world-writable permissions"},
		{`\bchmod\s+\+s\b`, "setting setuid bit"},
		// G30: nc/ncat reverse shell (any argument order)
		{`\bnc\b.*\s-e\b`, "reverse shell via netcat"},
		{`\bncat\b.*\s-e\b`, "reverse shell via ncat"},
		// G31: python reverse shell (python, python2, python3, path-prefixed, any quote)
		{`(?:^|/)python[23]?\s+-c\s+.*(?:socket|subprocess)`, "scripting reverse shell"},
		// G31: node reverse shell
		{`\bnode\s+-e\s+.*(?:require\s*\(\s*['"]net['"]\)|child_process)`, "scripting reverse shell"},
		// G36: shell RC file modification (with or without space after >>)
		{`>>?\s*~?/?\.(?:bashrc|zshrc|profile|bash_profile)\b`, "modifying shell RC file"},
		// G38: fdisk
		{`\bfdisk\b`, "partition table editor"},
		// G39: dd with of=/dev/ (with or without if=)
		{`\bdd\b.*\bof=/dev/`, "raw disk write"},
		{`\bdd\b.*\bif=`, "raw disk operation"},
	}
	for _, d := range defs {
		re := regexp.MustCompile(d.pattern)
		regexPatterns = append(regexPatterns, dangerousRegex{re: re, reason: d.reason})
	}
}

// IsDangerousCommand checks if a shell command matches known dangerous patterns.
// Returns (dangerous, reason).
func IsDangerousCommand(cmd string) (bool, string) {
	normalized := normalizeCommand(cmd)

	// Literal substring checks
	for _, dp := range literalPatterns {
		if strings.Contains(normalized, dp.pattern) {
			return true, dp.reason
		}
	}

	// Regex checks (for evasion-resistant matching)
	for _, dp := range regexPatterns {
		if dp.re.MatchString(normalized) {
			return true, dp.reason
		}
	}

	// Piped execution (curl URL | sh pattern)
	if isPipedExecution(cmd) {
		return true, "piped remote execution"
	}
	return false, ""
}

// normalizeCommand strips leading/trailing whitespace and collapses
// pipe expressions to remove spaces around pipes for matching.
func normalizeCommand(cmd string) string {
	cmd = strings.TrimSpace(cmd)
	// Collapse spaces around pipes for pattern matching
	cmd = strings.ReplaceAll(cmd, " | ", "|")
	return cmd
}

// isPipedExecution checks if a command pipes output from a downloader
// (curl, wget) into a shell interpreter (sh, bash).
func isPipedExecution(cmd string) bool {
	normalized := normalizeCommand(cmd)
	// Split on pipes
	parts := strings.Split(normalized, "|")
	if len(parts) < 2 {
		return false
	}

	// Check if first part starts with curl/wget and last part is a shell
	first := strings.Fields(parts[0])
	if len(first) == 0 {
		return false
	}
	downloader := first[0]
	if downloader != "curl" && downloader != "wget" {
		return false
	}

	last := strings.TrimSpace(parts[len(parts)-1])
	shell := strings.Fields(last)
	if len(shell) == 0 {
		return false
	}
	switch shell[0] {
	case "sh", "bash", "zsh", "dash":
		return true
	}
	return false
}

// sensitivePaths are paths that should never be accessed by tools.
var sensitivePaths = []string{
	"/etc/shadow",
	"/etc/passwd",
	"/etc/sudoers",
	"/etc/master.passwd",
	"~/.ssh/*",
	"~/.aws/*",
	"~/.gnupg/*",
	"~/.config/gcloud/*",
	"~/.kube/config",
	"~/.docker/config.json",
	"~/.netrc",
	"~/.npmrc",
	"~/.pypirc",
	"~/.gitconfig",
	"~/.env",
	"**/.env",
	"**/credentials.json",
	"**/secrets.yaml",
	"**/secrets.yml",
	"**/secrets.json",
	"**/secrets.toml",
	"**/secret.yaml",
	"**/secret.yml",
	"**/secret.json",
	"**/secret.toml",
	"**/*.pem",
	"**/*.key",
}

// IsSensitivePath checks if a path matches known sensitive path patterns.
func IsSensitivePath(path string) bool {
	for _, sp := range sensitivePaths {
		expanded := expandHome(sp)
		if MatchPattern(expanded, path) {
			return true
		}
		// Also check exact match
		if path == expanded {
			return true
		}
	}
	return false
}

// expandHome replaces ~ with the literal home directory prefix.
// For pattern matching, we expand to a common prefix.
func expandHome(path string) string {
	if strings.HasPrefix(path, "~/") {
		home := homeDir()
		return home + path[1:]
	}
	return path
}

// homeDir returns the user's home directory, falling back to /root.
func homeDir() string {
	// Use os.UserHomeDir equivalent via environment
	for _, env := range []string{"HOME", "USERPROFILE"} {
		if v := envLookup(env); v != "" {
			return v
		}
	}
	return "/root"
}

// envLookup is a seam for testing environment variable resolution.
var envLookup = envLookupReal

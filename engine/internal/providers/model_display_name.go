package providers

import (
	"regexp"
	"strings"
)

// DeriveModelDisplayName names a model from its id when no source published a
// name for it. It is the last fallback in ListModels, after the provider's own
// /models payload and the embedded catalog, so every consumer sees the same
// derived name instead of each client guessing its own.
//
// Only id shapes whose naming is well established are derived. Every other id
// returns "", which leaves the entry unnamed and its id visible: a wrong name
// is worse than an honest id.
//
// The shapes, with the name each produces:
//   - claude-<family>-<major>[-<minor>][-<yyyymmdd>]  "Claude Opus 4.8"
//     (also found inside a longer id: "anthropic.claude-sonnet-4-5-20250929-v1:0",
//     "my-gateway-claude-sonnet-4-6")
//   - claude-<major>[-<minor>]-<family>[-<yyyymmdd>]   "Claude Sonnet 3.5"
//   - gpt-<version>[-<words>]                          "GPT-5.2 Codex"
//   - gemini-<version>[-<words>]                       "Gemini 2.5 Flash"
//   - grok-<version>[-<words>]                         "Grok 3 Mini Fast"
func DeriveModelDisplayName(id string) string {
	lower := strings.ToLower(id)
	if m := claudeFamilyFirst.FindStringSubmatch(lower); m != nil {
		return "Claude " + titleWord(m[1]) + " " + joinVersion(m[2], m[3])
	}
	if m := claudeVersionFirst.FindStringSubmatch(lower); m != nil {
		return "Claude " + titleWord(m[3]) + " " + joinVersion(m[1], m[2])
	}
	if m := versionedFamily.FindStringSubmatch(lower); m != nil {
		name := versionedFamilyNames[m[1]] + m[2]
		if m[3] != "" {
			name += " " + titleWords(m[3])
		}
		return name
	}
	return ""
}

var (
	// The version segments are bounded so a trailing release date is never
	// read as a minor version: "claude-opus-4-20250514" is Opus 4.
	claudeFamilyFirst  = regexp.MustCompile(`(?:^|[^a-z])claude-([a-z]+)-(\d{1,2})(?:-(\d{1,2}))?(?:-\d{8})?(?:$|[-@:])`)
	claudeVersionFirst = regexp.MustCompile(`(?:^|[^a-z])claude-(\d{1,2})(?:-(\d{1,2}))?-([a-z]+)(?:-\d{8})?(?:$|[-@:])`)
	// A version is digits with an optional ".digits" and an optional letter
	// suffix ("4o"). The trailing words are any hyphen-separated remainder.
	versionedFamily = regexp.MustCompile(`^(gpt|gemini|grok)-(\d+(?:\.\d+)?[a-z]?)(?:-([a-z0-9][a-z0-9.-]*))?$`)
)

// versionedFamilyNames is the prefix each versioned family's name starts with.
// GPT joins its version with a hyphen ("GPT-5.2"), matching OpenAI's naming.
var versionedFamilyNames = map[string]string{
	"gpt":    "GPT-",
	"gemini": "Gemini ",
	"grok":   "Grok ",
}

func joinVersion(major, minor string) string {
	if minor == "" {
		return major
	}
	return major + "." + minor
}

func titleWord(w string) string {
	if w == "" {
		return w
	}
	return strings.ToUpper(w[:1]) + w[1:]
}

func titleWords(s string) string {
	parts := strings.Split(s, "-")
	for i, p := range parts {
		parts[i] = titleWord(p)
	}
	return strings.Join(parts, " ")
}

package mcp

// scope.go — RFC 6750 § 3 scope challenge accumulation.
//
// When an MCP server returns 401 with WWW-Authenticate: Bearer scope="x y",
// the engine must union the challenged scopes with its current set and
// re-authorize. This file provides the parsing and union logic; callers
// (the 401-retry path and the interactive login path) use it to build the
// accumulated scope string.

import (
	"sort"
	"strings"
	"unicode"
)

// AccumulateScopes returns the space-separated union of existing scopes and
// a challenge scope set. Both inputs are space-delimited per RFC 6749 § 3.3.
// The result is sorted for deterministic output.
func AccumulateScopes(existing, challenge string) string {
	seen := make(map[string]struct{})
	for _, s := range strings.Fields(existing) {
		seen[s] = struct{}{}
	}
	for _, s := range strings.Fields(challenge) {
		seen[s] = struct{}{}
	}
	if len(seen) == 0 {
		return ""
	}
	merged := make([]string, 0, len(seen))
	for s := range seen {
		merged = append(merged, s)
	}
	sort.Strings(merged)
	return strings.Join(merged, " ")
}

// ParseBearerScope extracts the scope parameter from a WWW-Authenticate
// Bearer challenge header value. Returns "" when no scope is present.
//
// The grammar (RFC 6750 § 3):
//
//	Bearer realm="example", scope="read write", error="insufficient_scope"
func ParseBearerScope(wwwAuthenticate string) string {
	for _, challenge := range strings.Split(wwwAuthenticate, ",") {
		challenge = strings.TrimSpace(challenge)
		if !strings.HasPrefix(strings.ToLower(challenge), "bearer") && !strings.Contains(strings.ToLower(challenge), "scope=") {
			continue
		}
		idx := strings.Index(strings.ToLower(challenge), "scope=")
		if idx < 0 {
			continue
		}
		value := strings.TrimLeftFunc(challenge[idx+len("scope="):], unicode.IsSpace)
		if len(value) == 0 {
			continue
		}
		if value[0] != '"' {
			return strings.Fields(value)[0]
		}
		value = value[1:]
		if end := strings.IndexByte(value, '"'); end >= 0 {
			return value[:end]
		}
	}
	return ""
}

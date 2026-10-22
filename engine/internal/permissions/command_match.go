package permissions

import (
	"regexp"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// commandMatcher reports whether a rule's command pattern matches a command.
type commandMatcher func(pattern, cmd string) bool

// regexCache holds compiled policy-rule command patterns. A nil entry records
// a pattern that failed to compile, so the error is logged once.
var regexCache = struct {
	sync.Mutex
	byPattern map[string]*regexp.Regexp
}{byPattern: map[string]*regexp.Regexp{}}

// matchCommandRegex is the matcher for policy rules: commandPatterns are
// regular expressions searched (unanchored) in the full command string, so a
// pattern finds its target inside a compound command such as
// `cd /tmp && terraform apply`. Anchors in the pattern are the author's
// choice. A pattern that does not compile matches nothing.
func matchCommandRegex(pattern, cmd string) bool {
	regexCache.Lock()
	re, ok := regexCache.byPattern[pattern]
	if !ok {
		var err error
		re, err = regexp.Compile(pattern)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "permissions", "invalid rule command pattern; rule will not match", map[string]any{
				"pattern": pattern, "error": err.Error(),
			})
			re = nil
		}
		regexCache.byPattern[pattern] = re
	}
	regexCache.Unlock()
	return re != nil && re.MatchString(cmd)
}

// matchCommandGlob is the matcher for skill grants, whose patterns use the
// `allowed-tools` glob form (`git add *`). The whole command must match; `*`
// matches any run of characters, slashes included, and `?` matches one.
func matchCommandGlob(pattern, cmd string) bool {
	var b strings.Builder
	b.WriteString("(?s)^")
	for _, r := range pattern {
		switch r {
		case '*':
			b.WriteString(".*")
		case '?':
			b.WriteString(".")
		default:
			b.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	b.WriteString("$")
	return matchCommandRegex(b.String(), cmd)
}

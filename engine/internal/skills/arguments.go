package skills

import (
	"regexp"
	"strconv"
	"strings"
)

var (
	argIndexedRE = regexp.MustCompile(`\$ARGUMENTS\[(\d+)\]`)
	argShorthand = regexp.MustCompile(`\$(\d+)`)
)

// SubstituteArguments expands argument placeholders in a template body with the
// user-supplied args. Supported forms:
//   - $ARGUMENTS      → the full raw argument string
//   - $ARGUMENTS[N]   → the Nth whitespace-split argument (empty if out of range)
//   - $N              → shorthand for $ARGUMENTS[N]
//
// When the body contains NO placeholder and args is non-empty, the args are
// appended as a trailing "ARGUMENTS: {args}" block so a template that does not
// reference $ARGUMENTS still receives the user's input. When args is empty the
// body is returned unchanged (placeholders collapse to empty).
func SubstituteArguments(body, args string) string {
	original := body
	parsed := strings.Fields(args)

	body = argIndexedRE.ReplaceAllStringFunc(body, func(m string) string {
		sub := argIndexedRE.FindStringSubmatch(m)
		i, _ := strconv.Atoi(sub[1]) //nolint:errcheck // parse failure -> zero value
		if i >= 0 && i < len(parsed) {
			return parsed[i]
		}
		return ""
	})
	body = argShorthand.ReplaceAllStringFunc(body, func(m string) string {
		i, _ := strconv.Atoi(m[1:]) //nolint:errcheck // parse failure -> zero value
		if i >= 0 && i < len(parsed) {
			return parsed[i]
		}
		return ""
	})
	body = strings.ReplaceAll(body, "$ARGUMENTS", args)

	// appendIfNoPlaceholder: nothing was substituted and we have args.
	if body == original && args != "" {
		body = body + "\n\nARGUMENTS: " + args
	}
	return body
}

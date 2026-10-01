package sandbox

import "regexp"

// CompiledPattern is a DangerousPattern whose expression compiled. Build one
// with CompilePatterns; the zero value matches nothing.
type CompiledPattern struct {
	Pattern string
	Reason  string
	re      *regexp.Regexp
}

// PatternError reports one configured pattern that could not be compiled.
// Index is the pattern's position in the list handed to CompilePatterns.
type PatternError struct {
	Index   int
	Pattern string
	Err     error
}

// CompilePatterns compiles a configured pattern list once, so a command check
// does not recompile per call and an authoring mistake is found when the
// configuration is loaded rather than never. Patterns that compile are
// returned in their configured order; each one that does not is returned as a
// PatternError and left out of the compiled list.
func CompilePatterns(patterns []DangerousPattern) ([]CompiledPattern, []PatternError) {
	var compiled []CompiledPattern
	var errs []PatternError
	for i, p := range patterns {
		re, err := regexp.Compile(p.Pattern)
		if err != nil {
			errs = append(errs, PatternError{Index: i, Pattern: p.Pattern, Err: err})
			continue
		}
		compiled = append(compiled, CompiledPattern{Pattern: p.Pattern, Reason: p.Reason, re: re})
	}
	return compiled, errs
}

// MatchPatterns returns the first compiled pattern the command matches. It
// checks only the given patterns: the built-in sandbox-escape patterns belong
// to ValidateShellSyntax and apply when a command is being sandboxed.
func MatchPatterns(command string, patterns []CompiledPattern) (CompiledPattern, bool) {
	for _, p := range patterns {
		if p.re != nil && p.re.MatchString(command) {
			return p, true
		}
	}
	return CompiledPattern{}, false
}

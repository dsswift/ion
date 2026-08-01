package workspaces

import (
	"path/filepath"
	"strings"
)

// bashSegment is one shell segment (between && / || / ; / | / newline) with
// the directory it can be PROVEN to operate in and the git subcommands it
// invokes. Dir is empty when the segment runs in the session cwd.
type bashSegment struct {
	// Dir is the literal working directory the segment operates in: the last
	// literal cd/pushd destination seen so far, or a per-invocation
	// `git -C <dir>` / `--work-tree=<dir>` target. Empty = session cwd.
	Dir string
	// GitSubcommands are the git verbs the segment invokes, in order.
	GitSubcommands []string
	// MergeDriverOnly is true when every `git merge` in the segment is a
	// `--continue` or `--abort` — the verbs that drive an existing merge
	// rather than create one. A segment mixing a driver verb with a fresh
	// merge is not driver-only.
	MergeDriverOnly bool
}

// bashDestinations is the resolution result for one command string.
type bashDestinations struct {
	Segments []bashSegment
	// UnresolvedHint records a destination-changing construct that could not
	// be resolved literally (`cd "$VAR"`, `cd $(...)`). The command PASSES —
	// refusing would block legitimate work in the conversation's own worktree
	// — and the caller logs the hint at WARN so the residual gap is queryable
	// rather than invisible.
	UnresolvedHint string
}

// valueTakingGitGlobals are git global options that consume the FOLLOWING
// token as their value. They must be skipped in pairs to reach the real
// subcommand, so `git -C /repo commit` resolves to `commit`, not `/repo`.
var valueTakingGitGlobals = map[string]bool{
	"-C": true, "-c": true, "--git-dir": true, "--work-tree": true,
	"--namespace": true, "--exec-path": true, "--config-env": true,
}

// resolveBashDestinations extracts every literal destination and git
// invocation from a shell command. Handles the shapes agents actually
// produce: `cd /x && git commit`, `git -C /repo push`, `pushd dir; make`,
// absolute git paths (`/usr/bin/git`), chained segments. Deliberately not a
// full shell parser — `eval`, subshell trickery, and dynamic paths defeat any
// command-string parser, and those pass with an UnresolvedHint instead of
// guessing.
func resolveBashDestinations(command, cwd string) bashDestinations {
	var out bashDestinations

	for _, rawSegment := range splitShellSegments(command) {
		tokens := tokenizeShell(rawSegment)
		if len(tokens) == 0 {
			continue
		}
		seg := bashSegment{MergeDriverOnly: true}
		// Carry the directory forward from the previous segment: `cd /x &&
		// git commit` commits in /x, and the cd's effect persists across
		// segment boundaries within one command string.
		if n := len(out.Segments); n > 0 {
			seg.Dir = out.Segments[n-1].Dir
		}

		for i := 0; i < len(tokens); i++ {
			tok := tokens[i]

			switch tok {
			case "cd", "pushd":
				if i+1 >= len(tokens) {
					continue // bare `cd` = $HOME; not a containment concern
				}
				dest := tokens[i+1]
				if isDynamicToken(dest) {
					out.UnresolvedHint = tok + " " + dest
					continue
				}
				seg.Dir = absolutize(dest, effectiveDir(seg.Dir, cwd))
				i++
				continue
			}

			if !isGitExecutable(tok) {
				continue
			}

			// Walk the git invocation: skip global options (value-taking ones
			// consume the next token), capture -C/--work-tree destinations,
			// then read the subcommand.
			gitDir := ""
			j := i + 1
			for j < len(tokens) {
				t := tokens[j]
				if !strings.HasPrefix(t, "-") {
					break
				}
				if t == "-C" || t == "--work-tree" {
					if j+1 < len(tokens) {
						dest := tokens[j+1]
						if isDynamicToken(dest) {
							out.UnresolvedHint = "git " + t + " " + dest
						} else {
							gitDir = absolutize(dest, effectiveDir(seg.Dir, cwd))
						}
						j += 2
						continue
					}
					j++
					continue
				}
				if eq := strings.IndexByte(t, '='); eq > 0 {
					// `--git-dir=/x`, `--work-tree=/x` carry the value inline.
					if t[:eq] == "--work-tree" {
						dest := t[eq+1:]
						if isDynamicToken(dest) {
							out.UnresolvedHint = "git " + t
						} else {
							gitDir = absolutize(dest, effectiveDir(seg.Dir, cwd))
						}
					}
					j++
					continue
				}
				if valueTakingGitGlobals[t] {
					j += 2
					continue
				}
				j++
			}
			if j >= len(tokens) {
				break
			}
			sub := tokens[j]
			if isDynamicToken(sub) {
				out.UnresolvedHint = "git " + sub
				i = j
				continue
			}
			seg.GitSubcommands = append(seg.GitSubcommands, sub)
			if sub == "merge" {
				rest := tokens[j+1:]
				driver := false
				for _, t := range rest {
					if t == "--continue" || t == "--abort" || t == "--quit" {
						driver = true
						break
					}
				}
				if !driver {
					seg.MergeDriverOnly = false
				}
			}
			// A per-invocation `git -C <dir>` names where THIS invocation
			// runs without changing the segment's cd state: judge it as its
			// own segment so the destination is not lost.
			if gitDir != "" && gitDir != seg.Dir {
				out.Segments = append(out.Segments, bashSegment{
					Dir:             gitDir,
					GitSubcommands:  []string{sub},
					MergeDriverOnly: seg.MergeDriverOnly,
				})
				// Remove it from the ambient segment: it was judged above.
				seg.GitSubcommands = seg.GitSubcommands[:len(seg.GitSubcommands)-1]
			}
			i = j
		}

		out.Segments = append(out.Segments, seg)
	}
	return out
}

func effectiveDir(segDir, cwd string) string {
	if segDir != "" {
		return segDir
	}
	return cwd
}

func absolutize(path, base string) string {
	path = strings.Trim(path, `"'`)
	if filepath.IsAbs(path) {
		return filepath.Clean(path)
	}
	if base == "" {
		return ""
	}
	return filepath.Clean(filepath.Join(base, path))
}

// isDynamicToken reports whether a token's value cannot be known statically:
// variable expansion, command substitution, backticks, tilde (whose expansion
// depends on the executing user), or glob characters.
func isDynamicToken(tok string) bool {
	return strings.ContainsAny(tok, "$`~*?")
}

// isGitExecutable matches bare `git` and any path ending in /git
// (`/usr/bin/git`). Matched on the exact basename so `gitleaks` or
// `git-crypt` — different programs that do not take git subcommands — are not
// mistaken for git and do not produce phantom refusals.
func isGitExecutable(tok string) bool {
	tok = strings.Trim(tok, `"'`)
	if tok == "" {
		return false
	}
	return filepath.Base(tok) == "git"
}

// splitShellSegments splits a command on the shell operators that sequence
// commands (&&, ||, ;, |, newline), respecting single and double quotes so a
// quoted operator (a commit message containing "&&") does not split.
func splitShellSegments(command string) []string {
	var segments []string
	var cur strings.Builder
	var quote byte

	flush := func() {
		s := strings.TrimSpace(cur.String())
		if s != "" {
			segments = append(segments, s)
		}
		cur.Reset()
	}

	for i := 0; i < len(command); i++ {
		ch := command[i]
		if quote != 0 {
			cur.WriteByte(ch)
			if ch == quote {
				quote = 0
			}
			continue
		}
		switch ch {
		case '\'', '"':
			quote = ch
			cur.WriteByte(ch)
		case '\n', ';':
			flush()
		case '&':
			if i+1 < len(command) && command[i+1] == '&' {
				flush()
				i++
			} else {
				cur.WriteByte(ch)
			}
		case '|':
			if i+1 < len(command) && command[i+1] == '|' {
				i++
			}
			flush()
		default:
			cur.WriteByte(ch)
		}
	}
	flush()
	return segments
}

// tokenizeShell splits one segment into tokens, keeping quoted spans as
// single tokens (with quotes retained; absolutize strips them). A quoted
// commit message must not tokenize into separate words that could be mistaken
// for subcommands.
func tokenizeShell(segment string) []string {
	var tokens []string
	var cur strings.Builder
	var quote byte

	flush := func() {
		if cur.Len() > 0 {
			tokens = append(tokens, cur.String())
			cur.Reset()
		}
	}

	for i := 0; i < len(segment); i++ {
		ch := segment[i]
		if quote != 0 {
			cur.WriteByte(ch)
			if ch == quote {
				quote = 0
			}
			continue
		}
		switch ch {
		case '\'', '"':
			quote = ch
			cur.WriteByte(ch)
		case ' ', '\t':
			flush()
		default:
			cur.WriteByte(ch)
		}
	}
	flush()
	return tokens
}

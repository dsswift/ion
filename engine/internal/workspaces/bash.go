package workspaces

import (
	"path/filepath"
	"strings"
)

// gitOperation is one parsed Git subcommand. Arguments exclude global Git
// options and the subcommand itself, so policy never mistakes a commit message
// or shell token for a destructive flag.
type gitOperation struct {
	Subcommand string
	Arguments  []string
}

// WorktreeIdentityChange reports whether this operation changes what the
// worktree IS — which branch it holds, or whether it exists at all.
//
// The list is deliberately tiny. An earlier revision refused every verb that
// could theoretically detach HEAD (rebase, reset, stash, cherry-pick, amend,
// push, branch -f), which broke the operator's own workflows: `/align` amends a
// branch-local commit through `git stash` + `git rebase -i` + `git commit
// --amend` + `git rebase --continue`, `/squash` rebuilds from `git reset --soft
// {base}` behind a `git branch -f backup--<branch>` safety net, and
// `/create-pr` pushes. Those are the sanctioned mechanisms, not accidents.
//
// The invariant that was actually violated is an END STATE — HEAD left detached
// mid-rebase — not the use of any particular verb. That is enforced after
// execution by InspectAttachment, which is what makes this list safe to keep
// narrow. Here we refuse only what no in-worktree workflow legitimately does:
// deliberately detaching HEAD, switching the checkout to another branch, or
// removing the worktree out from under the conversation living in it.
func (o gitOperation) WorktreeIdentityChange() (string, bool) {
	switch o.Subcommand {
	case "checkout":
		// `--detach` is unambiguous intent to leave the assigned branch.
		// `-b`/`-B` create a branch AND move the checkout onto it.
		//
		// A bare `git checkout <token>` is NOT refused: it is ambiguous
		// between a ref and a pathspec, and the file-restore form (including
		// restoring a DELETED file, where the path no longer exists to probe)
		// is ordinary work. Guessing wrong there refuses real work in the
		// operator's own worktree, so the detach outcome is left to the
		// post-execution attachment check instead.
		if containsAny(o.Arguments, "--detach") {
			return "checkout --detach", true
		}
		if containsShortFlag(o.Arguments, 'b', 'B') {
			return "checkout -b", true
		}
		return "", false
	case "switch":
		// `switch` has no pathspec form — every invocation that names
		// something moves the checkout. `--continue`/`--abort` drive an
		// in-progress switch and are how one is unwound, so they pass.
		if containsAny(o.Arguments, "--continue", "--abort") {
			return "", false
		}
		if containsAny(o.Arguments, "--detach") {
			return "switch --detach", true
		}
		if len(o.Arguments) == 0 {
			return "", false
		}
		return "switch", true
	case "worktree":
		// `add` and `list` are fine — `/align` PR mode cuts a dedicated
		// worktree for PR fixes. `remove`/`move`/`prune` can delete or
		// relocate the directory this conversation is living in.
		for _, argument := range o.Arguments {
			switch argument {
			case "remove", "move", "prune":
				return "worktree " + argument, true
			}
		}
		return "", false
	default:
		return "", false
	}
}

func containsAny(values []string, want ...string) bool {
	for _, value := range values {
		for _, candidate := range want {
			if value == candidate || strings.HasPrefix(value, candidate+"=") {
				return true
			}
		}
	}
	return false
}

func containsShortFlag(values []string, flags ...rune) bool {
	for _, value := range values {
		if !strings.HasPrefix(value, "-") || strings.HasPrefix(value, "--") {
			continue
		}
		for _, flag := range flags {
			if strings.ContainsRune(value[1:], flag) {
				return true
			}
		}
	}
	return false
}

// bashSegment is one shell segment (between && / || / ; / | / newline) with
// the directory it can be PROVEN to operate in and the Git subcommands it
// invokes. Dir is empty when the segment runs in the session cwd.
type bashSegment struct {
	// Dir is the literal working directory the segment operates in: the last
	// literal cd/pushd destination seen so far, or a per-invocation
	// `git -C <dir>` / `--work-tree=<dir>` target. Empty = session cwd.
	Dir string
	// GitSubcommands are the Git verbs the segment invokes, in order.
	GitSubcommands []string
	// GitOperations retain each invocation's subcommand and arguments so policy
	// can distinguish destructive forms such as `restore --staged` from reads.
	GitOperations []gitOperation
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

	rawSegments := splitShellSegments(command)
	for _, rawSegment := range rawSegments {
		tokens := tokenizeShell(rawSegment)
		if len(tokens) == 0 {
			continue
		}
		seg := bashSegment{}
		// Carry the directory forward from the previous segment: `cd /x &&
		// git commit` commits in /x, and the cd's effect persists across
		// segment boundaries within one command string.
		if n := len(out.Segments); n > 0 {
			seg.Dir = out.Segments[n-1].Dir
		}

		for i := 0; i < len(tokens); i++ {
			tok := normalizeGroupingToken(tokens[i])

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
			op := gitOperation{Subcommand: sub, Arguments: append([]string(nil), tokens[j+1:]...)}
			seg.GitOperations = append(seg.GitOperations, op)
			// A per-invocation `git -C <dir>` names where THIS invocation
			// runs without changing the segment's cd state: judge it as its
			// own segment so the destination is not lost.
			if gitDir != "" && gitDir != seg.Dir {
				out.Segments = append(out.Segments, bashSegment{
					Dir:            gitDir,
					GitSubcommands: []string{sub},
					GitOperations:  []gitOperation{op},
				})
				// Remove it from the ambient segment: it was judged above.
				seg.GitSubcommands = seg.GitSubcommands[:len(seg.GitSubcommands)-1]
				seg.GitOperations = seg.GitOperations[:len(seg.GitOperations)-1]
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

func normalizeGroupingToken(token string) string {
	return strings.TrimLeft(token, "({")
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

// splitShellSegments splits a command on shell operators that create command
// boundaries (&&, ||, &, ;, |, newline), respecting single and double quotes.
// Parentheses and braces are retained in segments: recognizing their complete
// shell grammar safely requires a full parser, while operators inside them
// still expose the compound command's destinations conservatively.
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
			flush()
			if i+1 < len(command) && command[i+1] == '&' {
				i++
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

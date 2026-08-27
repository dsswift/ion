package tools

import (
	"fmt"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// bash_sleep_gate.go implements the leading-`sleep` refusal for foreground
// Bash commands.
//
// The engine already owns a complete mechanism for waiting on long work:
// `run_in_background` + `notify_on_complete` registers the command as
// outstanding, parks the session at the turn boundary, and wakes it with the
// result when the command exits (ADR-023). A foreground `sleep` defeats that
// mechanism entirely — it pins a shell for the duration, produces nothing, and
// delays the very completion it is waiting for. Prose guidance alone does not
// hold: conversation 1785107715785-e4b5e9ec1ecb started a build with
// notify_on_complete (correctly parked by the engine) and then ran
// `sleep 600; tail -20 <output>` anyway, burning ten minutes for a result the
// wake path was already going to deliver.
//
// # The head-only rule
//
// Detection inspects ONLY the leading segment of the command — the text before
// the first top-level `;`, `&&`, `||`, or `|` — and fires only when that
// segment is exactly `sleep <integer>` with the integer at or above the
// configured threshold.
//
// This is deliberately narrow, and the asymmetry is the whole design: a false
// negative costs one wasted command, while a false positive blocks legitimate
// work with no way around it short of a config change. So everything
// ambiguous is allowed through:
//
//   - `sleep 0.5` — fractional sleeps are pacing (rate limiting, a settle
//     window between a write and a read), not waiting.
//   - `foo | sleep 5`, `make && sleep 5` — a sleep that is not the head of the
//     command is part of a pipeline or sequence doing real work.
//   - `while true; do sleep 5; done`, `bash -c "sleep 30"` — a sleep inside a
//     loop, subshell, or nested shell invocation is never inspected.
//
// The gate applies to both foreground and background calls. A detached bare
// sleep produces no useful work; a notifying one also holds the session and
// injects a wake turn. Poll owns real inference-driven wait-and-recheck loops.

// blockingSleepPattern matches a bare `sleep <integer>` — the exact shape of a
// blocking wait. Fractional durations are excluded by requiring digits only.
var blockingSleepPattern = regexp.MustCompile(`^sleep\s+(\d+)$`)

// commandSeparators are the shell operators that end the leading segment.
// Ordered longest-first so `&&` is found before a bare `&`-adjacent scan of
// `|` would mis-split `||`.
var commandSeparators = []string{"&&", "||", ";", "|"}

// leadingCommandSegment returns the portion of command before the first
// top-level separator (`;`, `&&`, `||`, `|`), trimmed.
//
// This is a deliberately shallow split: it does not parse quoting, subshells,
// or heredocs, because it does not need to. A separator appearing inside a
// quoted string (`echo "a; b"`) can only cause the segment to END EARLIER than
// a true parse would, which yields a shorter head that then fails the exact
// `sleep <integer>` match — a false negative, which the head-only rule accepts.
func leadingCommandSegment(command string) string {
	head := command
	for _, sep := range commandSeparators {
		if idx := strings.Index(head, sep); idx >= 0 {
			head = head[:idx]
		}
	}
	return strings.TrimSpace(head)
}

// detectBlockingSleep reports whether command begins with a blocking
// `sleep N` at or above threshold, and the N it found.
//
// Returns (0, false) when the leading segment is not a bare integer sleep, or
// when the duration is below the threshold (short sleeps are pacing, not
// waiting).
func detectBlockingSleep(command string, threshold time.Duration) (seconds int, blocked bool) {
	head := leadingCommandSegment(command)
	m := blockingSleepPattern.FindStringSubmatch(head)
	if m == nil {
		return 0, false
	}
	// The regexp guarantees digits only; a parse failure here means the value
	// overflowed int, which is unambiguously longer than any threshold.
	secs, err := strconv.Atoi(m[1])
	if err != nil {
		return 0, true
	}
	if time.Duration(secs)*time.Second < threshold {
		return secs, false
	}
	return secs, true
}

// blockingSleepMessage renders the refusal. It names the mechanism that
// replaces the sleep in both directions — waiting for completion, and checking
// progress — because a refusal that does not say what to do instead just gets
// retried.
//
// taskToolsRegistered reports whether TaskGet is in the tool registry; when it
// is not (the Task tools are harness opt-in, see optional.go), the progress
// path is reading the task's output file directly.
func blockingSleepMessage(seconds int, threshold time.Duration, background, taskToolsRegistered bool) string {
	var b strings.Builder
	mode := "foreground"
	if background {
		mode = "background"
	}
	fmt.Fprintf(&b, "Blocked: this %s command is a bare `sleep %d`, which produces no useful work. ", mode, seconds)
	fmt.Fprintf(&b, "A bare sleep of %s or longer is refused; the command was not executed.\n\n", threshold)
	b.WriteString("To wait for a real command, start that command with `run_in_background: true` and `notify_on_complete: true`. ")
	b.WriteString("Its result is delivered to this session when it finishes — you do not poll and you do not sleep.\n")
	b.WriteString("For wait-and-recheck work, use `Poll`: it checks evidence in the background and delivers one terminal verdict.\n")
	if taskToolsRegistered {
		b.WriteString("TaskGet is available for an explicit one-time status read, not a polling loop.\n")
	} else {
		b.WriteString("Read a real task's output file for an explicit one-time progress inspection.\n")
	}
	fmt.Fprintf(&b, "A short delay for pacing (under %s) is still allowed.", threshold)
	return b.String()
}

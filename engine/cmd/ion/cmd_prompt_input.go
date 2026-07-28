package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"strings"
)

// errPromptTextRequired is returned when no prompt text is available from
// either positional arguments or stdin.
var errPromptTextRequired = errors.New("prompt text required")

// resolvePromptText determines the prompt body for `ion prompt`, from
// positional arguments or from stdin.
//
// Reading from stdin is not a convenience. A single argv entry is capped at
// MAX_ARG_STRLEN (128 KiB on Linux) independently of the much larger total
// ARG_MAX, so `ion prompt "$(cat big-file)"` fails with "Argument list too
// long" once the prompt crosses that ceiling — no matter how much room the
// overall argument list has. Any consumer assembling a large prompt (a CI job,
// a shell pipeline, an automation harness) hits a hard wall with argv alone.
//
// Resolution order:
//   - Positional arguments, other than the single token "-", are joined with a
//     single space. This is the pre-existing behaviour and takes precedence.
//   - An explicit "-" reads stdin unconditionally, which is how a caller opts
//     in when stdin's shape cannot be detected.
//   - No positional arguments reads stdin only when stdin is not an
//     interactive terminal. On a TTY there is nothing to read and blocking
//     forever on the terminal would be worse than the usage error, so the
//     "prompt text required" error is returned instead.
func resolvePromptText(positional []string, stdin *os.File) (string, error) {
	explicitStdin := len(positional) == 1 && positional[0] == "-"

	if len(positional) > 0 && !explicitStdin {
		text := strings.Join(positional, " ")
		if text == "" {
			return "", errPromptTextRequired
		}
		return text, nil
	}

	if !explicitStdin && isCharDevice(stdin) {
		// Interactive terminal with no prompt argument: nothing is piped in.
		return "", errPromptTextRequired
	}

	data, err := io.ReadAll(stdin)
	if err != nil {
		return "", fmt.Errorf("reading prompt from stdin: %w", err)
	}
	text := strings.TrimRight(string(data), "\r\n")
	if text == "" {
		return "", errPromptTextRequired
	}
	return text, nil
}

// isCharDevice reports whether f is a character device (an interactive
// terminal), as opposed to a pipe, a redirected file, or a socket. A failed
// Stat is treated as "not a terminal" so the caller falls through to the read
// rather than rejecting a prompt it could have served.
func isCharDevice(f *os.File) bool {
	if f == nil {
		return true
	}
	info, err := f.Stat()
	if err != nil {
		return false
	}
	return info.Mode()&os.ModeCharDevice != 0
}

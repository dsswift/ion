package backend

import (
	"fmt"
	"os/exec"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// bareExitDiagnostic builds a rich error message for the case where the claude
// CLI exits non-zero with no stderr output captured. The bare "claude CLI
// exited with code N" message gives an operator nothing actionable; this
// enriches it with all context in scope at the exit point.
//
// Included fields:
//   - exit code
//   - explicit "(no stderr captured)" marker
//   - PID and elapsed since spawn
//   - resolved binary path
//   - working directory ("<inherited>" when cmd.Dir is empty)
//   - model ("<default>" when not specified in opts)
//   - redacted argv: values following --system-prompt / --append-system-prompt
//     are masked as "<redacted len=N>". User prompt is delivered over stdin and
//     never appears in argv, so no prompt content can leak.
func bareExitDiagnostic(run *claudeCodeRun, opts types.RunOptions, exitCode int, cmd *exec.Cmd) string {
	pid := 0
	if cmd != nil && cmd.Process != nil {
		pid = cmd.Process.Pid
	}

	var elapsed time.Duration
	if !run.spawnedAt.IsZero() {
		elapsed = time.Since(run.spawnedAt)
	}

	binaryPath := run.binaryPath
	if binaryPath == "" {
		binaryPath = "<unknown>"
	}

	cwd := "<inherited>"
	if cmd != nil && cmd.Dir != "" {
		cwd = cmd.Dir
	}

	model := opts.Model
	if model == "" {
		model = "<default>"
	}

	var argv string
	if cmd != nil {
		argv = formatRedactedArgv(cmd.Args)
	}

	return fmt.Sprintf(
		"claude CLI exited with code %d (no stderr captured) [pid=%d elapsed=%s binary=%s cwd=%s model=%s argv=%s]",
		exitCode, pid, elapsed.Round(time.Millisecond), binaryPath, cwd, model, argv,
	)
}

// formatRedactedArgv returns cmd.Args as a space-joined string with sensitive
// flag values masked. The flags --system-prompt and --append-system-prompt
// accept long multi-line values that must not appear in logs; their arguments
// are replaced with "<redacted len=N>" where N is the original byte length.
// All other arguments are emitted verbatim.
func formatRedactedArgv(args []string) string {
	sensitiveFlags := map[string]bool{
		"--system-prompt":        true,
		"--append-system-prompt": true,
	}

	out := make([]string, 0, len(args))
	for i := 0; i < len(args); i++ {
		arg := args[i]
		if sensitiveFlags[arg] && i+1 < len(args) {
			out = append(out, arg)
			out = append(out, fmt.Sprintf("<redacted len=%d>", len(args[i+1])))
			i++ // skip the value
			continue
		}
		out = append(out, arg)
	}
	return strings.Join(out, " ")
}

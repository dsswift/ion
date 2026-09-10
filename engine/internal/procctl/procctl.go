// Package procctl provides one process-tree control primitive used by every
// subprocess spawner in the engine (the Bash tool, the claude-code backend,
// the codex/ACP RPC spawner, and extension hosts) plus the process-liveness
// probes in durablefile and filelock.
//
// The platform table:
//
//   - Configure prepares a *exec.Cmd before Start. Unix sets Setpgid so the
//     spawned tree shares one process group. Windows sets
//     CREATE_NEW_PROCESS_GROUP so a Ctrl-C delivered to the engine's own
//     console does not reach the child.
//   - AfterStart must run immediately after Start succeeds. Unix: no-op, the
//     process group is already established by Configure. Windows: creates a
//     Job Object with JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE and assigns the
//     child to it, so TerminateJobObject later ends the whole tree in one
//     call and the tree also dies if the engine itself dies.
//   - KillTree ends the whole tree rooted at cmd: SIGKILL to -pgid on unix,
//     TerminateJobObject on windows (falling back to Process.Kill when no
//     job was attached, e.g. AfterStart failed or was never called).
//   - Interrupt asks the tree to stop gracefully: SIGINT to -pgid on unix.
//     Windows has no cross-console way to deliver Ctrl-C to an unrelated
//     process, so it returns ErrNoGracefulSignal and callers fall back to
//     KillTree.
//   - Alive reports whether a process with pid exists: kill(pid, 0) on
//     unix, OpenProcess + GetExitCodeProcess(STILL_ACTIVE) on windows.
//   - Release drops any tracking state held for cmd (the Windows job
//     handle). Callers invoke it once after cmd.Wait returns.
package procctl

import "errors"

// tag is the logging tag every procctl log line carries.
const tag = "procctl"

// ErrNoGracefulSignal is returned by Interrupt on platforms with no
// cross-process graceful-stop signal (Windows). Callers should fall back to
// KillTree.
var ErrNoGracefulSignal = errors.New("procctl: no graceful signal on this platform")

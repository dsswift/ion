package backend

import (
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// cliResumeArgs returns the `--resume <uuid>` argument pair for a CLI run,
// or nil when the run must start a fresh claude session.
//
// The resume id is sourced *only* from opts.CliResumeSessionID — the
// claude-native session UUID the manager captured from a previous run's
// SessionInitEvent/TaskCompleteEvent. It is never sourced from
// opts.SessionID (Ion's `{millis}-{12hex}` conversation-file identity),
// which the claude CLI rejects with exit code 1.
//
// Contract:
//   - First run of a session (CliResumeSessionID == ""): returns nil, so the
//     backend omits --resume and claude starts a fresh session.
//   - Subsequent runs (CliResumeSessionID set): returns {"--resume", "<uuid>"}.
//
// Both branches log so the resume decision is reconstructible from
// ~/.ion/engine.log alone.
func cliResumeArgs(opts types.RunOptions) []string {
	if opts.CliResumeSessionID != "" {
		utils.Log("CliBackend", "resume: --resume "+opts.CliResumeSessionID)
		return []string{"--resume", opts.CliResumeSessionID}
	}
	// First run of this session: no claude UUID captured yet. Omitting
	// --resume is mandatory — claude rejects a missing/invalid resume id.
	// SessionID (Ion's conversation id) is intentionally NOT used here.
	utils.Log("CliBackend", "resume: omitting --resume (first CLI run, no captured claude session UUID; sessionID="+opts.SessionID+")")
	return nil
}

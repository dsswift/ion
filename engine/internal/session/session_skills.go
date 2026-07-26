package session

import (
	"github.com/dsswift/ion/engine/internal/skills"
	"github.com/dsswift/ion/engine/internal/utils"
)

// session_skills.go holds session-scoped skill teardown.
//
// Lives in its own file rather than in manager.go because manager.go is
// allowlisted for file size (engine/AGENTS.md: "Don't extend; add a new file
// in the same package"). StopSession calls clearSessionSkills; the helper
// itself belongs here.

// clearSessionSkills drops a stopped session's skill registrations so a
// project's skills do not outlive the session that loaded them.
//
// Safe by construction: start_session registers every skill this session
// loaded — user-scoped and project-scoped alike — into the session's own map,
// so eviction here can only ever remove this session's entries. Another live
// session's identically-named skills are in that session's own map and are
// untouched.
//
// Logs the evicted count so a session whose skills vanished (or never
// registered) is diagnosable from ~/.ion/engine.jsonl alone.
func clearSessionSkills(key string) {
	n := skills.ClearSkillsFor(key)
	utils.LogWithFields(utils.LevelInfo, "session", "session skills cleared", map[string]any{
		"key": key, "count": n,
	})
}

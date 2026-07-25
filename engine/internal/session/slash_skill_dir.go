package session

// slash_skill_dir.go carries the base-directory annotation applied to a
// SKILL.md body when a skill is resolved through the slash path. Skills ship
// companion files next to their SKILL.md (references/*.md, scripts, assets)
// and address them with paths relative to the skill directory; the model can
// only resolve those paths when the expanded body names the directory.
//
// The wording is pinned to match the Skill tool's execution path
// (tools/skill.go) so the model sees one convention regardless of how the
// skill was invoked. Tests in both packages pin the shared prefix.

// skillBaseDirPrefix is the first line of the annotation. Keep in sync with
// the Skill tool's base-directory line in tools/skill.go (pinned by tests).
const skillBaseDirPrefix = "Base directory for this skill: "

// skillBaseDirHint explains how relative paths resolve. Keep in sync with
// tools/skill.go (pinned by tests).
const skillBaseDirHint = "Relative paths in this skill (e.g. references/...) resolve against this base directory."

// annotateSkillBody prefixes a resolved skill body with its base directory so
// the model can resolve the skill's relative companion files. A prefix (not a
// suffix) so the location is established before the instructions that use it.
func annotateSkillBody(body, skillDir string) string {
	if skillDir == "" {
		return body
	}
	return skillBaseDirPrefix + skillDir + "\n" + skillBaseDirHint + "\n\n" + body
}

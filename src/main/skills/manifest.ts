/**
 * Skill manifest — defines which skills CODA auto-installs into ~/.claude/skills/.
 *
 * Two source types:
 *   - github: downloaded from a pinned commit SHA (deterministic, not branch tip)
 *   - bundled: copied from CODA's own resources (for skills we author ourselves)
 *
 * To add a new skill, append an entry here. The installer handles the rest.
 */

export interface SkillEntry {
  name: string
  source:
    | { type: 'github'; repo: string; path: string; commitSha: string }
    | { type: 'bundled' }
  version: string
  /** Files that must exist after install for validation */
  requiredFiles: string[]
}

export const SKILLS: SkillEntry[] = [
  {
    name: 'skill-creator',
    source: {
      type: 'github',
      repo: 'anthropics/skills',
      path: 'skills/skill-creator',
      commitSha: 'b0cbd3df1533b396d281a6886d5132f623393a9c',
    },
    version: '1.0.0',
    requiredFiles: [
      'SKILL.md',
      'agents/grader.md',
      'agents/comparator.md',
      'agents/analyzer.md',
      'references/schemas.md',
      'scripts/run_loop.py',
      'scripts/run_eval.py',
      'scripts/package_skill.py',
    ],
  },
]

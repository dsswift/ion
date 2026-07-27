package skills

import (
	"sort"
	"sync"

	"github.com/dsswift/ion/engine/internal/utils"
)

// skills_session.go holds the session-scoped skill registry.
//
// Why a second registry rather than reusing the package-level one in
// skills.go: the global registry is keyed by skill name alone, so a
// project-scoped skill loaded from <workingDir>/.ion/skills stayed registered
// after its session ended and was advertised to every other session — a
// project's skill leaked into unrelated conversations, and two projects with a
// same-named skill resolved to whichever session started last. Scoping
// resolution by session key makes a project skill visible only to sessions
// whose working directory actually contains it.
//
// The global registry and its functions (RegisterSkill / GetSkill /
// GetAllSkills / ListSkillNames / ClearSkillRegistry) are deliberately left
// intact. They are published surface an external SDK consumer or third-party
// harness may already call, and removing them would be a breaking change. A
// caller with no session key falls back to them (see the *For functions'
// empty-key branches), so existing behaviour is unchanged for anyone who has
// not adopted the session-scoped form.

var (
	sessionRegistryMu sync.RWMutex
	// sessionRegistry maps a session key to that session's own skill set.
	// Every session gets a complete map: user-scoped skills are copied into
	// each session at start rather than resolved through a shared fallback.
	// That is what makes ClearSkillsFor safe by construction — a session's
	// teardown can only ever evict its own entries and can never strip a
	// user skill that another live session is still using.
	sessionRegistry = make(map[string]map[string]*Skill)
)

// RegisterSkillFor adds or replaces a skill in one session's registry.
// An empty key falls back to the global registry so callers that have no
// session context keep working unchanged.
func RegisterSkillFor(key string, s *Skill) {
	if key == "" {
		RegisterSkill(s)
		return
	}
	sessionRegistryMu.Lock()
	defer sessionRegistryMu.Unlock()
	m, ok := sessionRegistry[key]
	if !ok {
		m = make(map[string]*Skill)
		sessionRegistry[key] = m
	}
	m[s.Name] = s
}

// GetSkillFor returns a skill by name from one session's registry, or nil.
// An empty key reads the global registry.
func GetSkillFor(key, name string) *Skill {
	if key == "" {
		utils.LogWithFields(utils.LevelDebug, "skills", "resolving against global registry (no session key)", map[string]any{"model": name})
		return GetSkill(name)
	}
	sessionRegistryMu.RLock()
	defer sessionRegistryMu.RUnlock()
	m, ok := sessionRegistry[key]
	if !ok {
		// No session map: the session registered nothing, or was already
		// torn down. Fall back to the global so a programmatically
		// registered skill is still reachable.
		utils.LogWithFields(utils.LevelDebug, "skills", "no session skill map; resolving against global registry", map[string]any{"key": key, "model": name})
		return GetSkill(name)
	}
	return m[name]
}

// GetAllSkillsFor returns every skill registered for one session.
// An empty key, or a key with no session map, reads the global registry.
func GetAllSkillsFor(key string) []*Skill {
	if key == "" {
		return GetAllSkills()
	}
	sessionRegistryMu.RLock()
	m, ok := sessionRegistry[key]
	if !ok {
		sessionRegistryMu.RUnlock()
		return GetAllSkills()
	}
	result := make([]*Skill, 0, len(m))
	for _, s := range m {
		result = append(result, s)
	}
	sessionRegistryMu.RUnlock()
	return result
}

// ListSkillNamesFor returns sorted names of one session's skills.
// An empty key, or a key with no session map, reads the global registry.
func ListSkillNamesFor(key string) []string {
	if key == "" {
		return ListSkillNames()
	}
	sessionRegistryMu.RLock()
	m, ok := sessionRegistry[key]
	if !ok {
		sessionRegistryMu.RUnlock()
		return ListSkillNames()
	}
	names := make([]string, 0, len(m))
	for name := range m {
		names = append(names, name)
	}
	sessionRegistryMu.RUnlock()
	sort.Strings(names)
	return names
}

// ClearSkillsFor drops one session's entire skill map. Called at session stop
// so a project's skills do not outlive the session that loaded them. Returns
// the number of entries evicted so the caller can log it; a session that
// registered nothing returns 0.
func ClearSkillsFor(key string) int {
	if key == "" {
		return 0
	}
	sessionRegistryMu.Lock()
	defer sessionRegistryMu.Unlock()
	n := len(sessionRegistry[key])
	delete(sessionRegistry, key)
	return n
}

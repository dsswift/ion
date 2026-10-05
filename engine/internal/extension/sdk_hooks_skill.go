package extension

import (
	"encoding/json"

	"github.com/dsswift/ion/engine/internal/utils"
)

// SkillLoadInfo is the payload for skill_load.
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type SkillLoadInfo struct {
	Name    string `json:"name"`
	Source  string `json:"source"`  // path of the SKILL.md
	BaseDir string `json:"baseDir"` // directory holding the SKILL.md
	Args    string `json:"args,omitempty"`
	// Invocation is "tool" (the model called the Skill tool) or "slash"
	// (the user typed /<skill>).
	Invocation  string         `json:"invocation"`
	Frontmatter map[string]any `json:"frontmatter,omitempty"`
	// Commands are the shell commands the body would run, in order. Empty
	// when the skill has none.
	Commands []string `json:"commands,omitempty"`
}

// SkillLoadResult is a skill_load handler's answer. Every field is optional.
//
// Field stability: new fields may be added with zero-value defaults; existing
// fields must not be removed or renamed.
type SkillLoadResult struct {
	// Allow vetoes the skill when false. Nil abstains. Last non-nil wins.
	Allow  *bool  `json:"allow,omitempty"`
	Reason string `json:"reason,omitempty"`
	// Content replaces the skill body before its commands are found and run.
	// Last non-empty wins.
	Content string `json:"content,omitempty"`
	// AppendContent is added after the rendered body, verbatim. Contributions
	// from every handler are joined in order.
	AppendContent string `json:"appendContent,omitempty"`
}

// mergeSkillLoad folds one handler's result into the running decision.
func mergeSkillLoad(acc *SkillLoadResult, r *SkillLoadResult) {
	if r == nil {
		return
	}
	if r.Allow != nil {
		acc.Allow = r.Allow
		acc.Reason = r.Reason
	}
	if r.Content != "" {
		acc.Content = r.Content
	}
	if r.AppendContent != "" {
		if acc.AppendContent != "" {
			acc.AppendContent += "\n\n"
		}
		acc.AppendContent += r.AppendContent
	}
}

func asSkillLoadResult(v interface{}) *SkillLoadResult {
	switch typed := v.(type) {
	case SkillLoadResult:
		return &typed
	case *SkillLoadResult:
		return typed
	case map[string]interface{}:
		raw, err := json.Marshal(typed)
		if err != nil {
			return nil
		}
		var r SkillLoadResult
		if err := json.Unmarshal(raw, &r); err != nil {
			return nil
		}
		return &r
	}
	return nil
}

// FireSkillLoad fires skill_load and merges every handler's answer.
func (s *SDK) FireSkillLoad(ctx *Context, info SkillLoadInfo) SkillLoadResult {
	var acc SkillLoadResult
	for _, r := range s.fire(HookSkillLoad, ctx, info) {
		mergeSkillLoad(&acc, asSkillLoadResult(r))
	}
	return acc
}

// FireSkillLoad fires skill_load on this host.
func (h *Host) FireSkillLoad(ctx *Context, info SkillLoadInfo) SkillLoadResult {
	return h.sdk.FireSkillLoad(ctx, info)
}

// FireSkillLoad fans skill_load out to every host with the same merge rules
// a single host applies: last non-nil Allow and last non-empty Content win,
// AppendContent accumulates.
func (g *ExtensionGroup) FireSkillLoad(ctx *Context, info SkillLoadInfo) SkillLoadResult {
	var acc SkillLoadResult
	for _, h := range g.hosts {
		r := h.FireSkillLoad(ctx, info)
		mergeSkillLoad(&acc, &r)
	}
	utils.LogWithFields(utils.LevelDebug, "extension.group", "skill_load resolved", map[string]any{
		"skill": info.Name, "invocation": info.Invocation, "denied": acc.Allow != nil && !*acc.Allow,
		"replaced": acc.Content != "", "appended": acc.AppendContent != "",
	})
	return acc
}

// registerSkillLoadForwarder forwards skill_load to a subprocess extension and
// decodes its structured answer.
func (h *Host) registerSkillLoadForwarder() {
	h.noteForwarder(HookSkillLoad, hookResultStructured)
	h.sdk.On(HookSkillLoad, func(ctx *Context, payload interface{}) (interface{}, error) {
		raw, err := h.callHook("hook/"+HookSkillLoad, ctx, payload)
		if err != nil {
			logHookErr(HookSkillLoad, err)
			return nil, nil
		}
		emitHookEvents(ctx, raw)
		if len(raw) == 0 || string(raw) == "null" {
			return nil, nil
		}
		var result SkillLoadResult
		if err := json.Unmarshal(raw, &result); err != nil {
			utils.LogWithFields(utils.LevelInfo, "extension", "hook/skill_load: bad result", map[string]any{"error": err})
			return nil, nil
		}
		return &result, nil
	})
}

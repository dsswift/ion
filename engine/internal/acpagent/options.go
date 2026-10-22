package acpagent

import (
	"context"
	"encoding/json"
	"sort"
	"time"

	"github.com/dsswift/ion/engine/internal/rpcstdio"
	"github.com/dsswift/ion/engine/internal/utils"
)

// findProfile resolves a profile by id or name. Empty, "none", or an
// unknown name resolves to nil: no extensions.
func (a *Agent) findProfile(ref string) *Profile {
	if ref == "" || ref == ProfileNone {
		return nil
	}
	for i := range a.opts.Profiles {
		p := &a.opts.Profiles[i]
		if p.ID == ref || p.Name == ref {
			return p
		}
	}
	utils.LogWithFields(utils.LevelWarn, "acp", "profile not found; loading no extensions", map[string]any{"profile": ref})
	return nil
}

// configOptions is the full option list with current values: the profile
// (which extension set the session runs) and the model. A pinned harness
// offers the model only; its extension set is not the client's to change.
func (s *Session) configOptions() []ConfigOption {
	models := s.agent.modelOptions()
	currentModel := s.effectiveModel()
	if currentModel != "" && !hasValue(models, currentModel) {
		models = append([]SelectOption{{Value: currentModel, Name: currentModel}}, models...)
	}
	model := ConfigOption{ID: ConfigModel, Name: "Model", Category: "model", Type: "select", CurrentValue: currentModel, Options: models}
	if s.agent.opts.Harness != nil {
		return []ConfigOption{model}
	}
	s.mu.Lock()
	profileID := s.profileID
	s.mu.Unlock()
	profiles := []SelectOption{{Value: ProfileNone, Name: "None", Description: "No extensions"}}
	for _, p := range s.agent.opts.Profiles {
		profiles = append(profiles, SelectOption{Value: p.ID, Name: p.Name})
	}
	if profileID == "" {
		profileID = ProfileNone
	}
	return []ConfigOption{
		{ID: ConfigProfile, Name: "Profile", Description: "Ion engine profile: the extensions this session loads", Type: "select", CurrentValue: profileID, Options: profiles},
		model,
	}
}

// effectiveModel is the model a prompt runs on: the session's choice, else
// the engine's default, else the first model the engine lists. An engine
// with no default and no models leaves it empty and the engine reports
// no_model_configured on the first prompt.
func (s *Session) effectiveModel() string {
	s.mu.Lock()
	model := s.model
	s.mu.Unlock()
	if model != "" {
		return model
	}
	if s.agent.opts.DefaultModel != "" {
		return s.agent.opts.DefaultModel
	}
	if models := s.agent.modelOptions(); len(models) > 0 {
		return models[0].Value
	}
	return ""
}

func hasValue(options []SelectOption, value string) bool {
	for _, o := range options {
		if o.Value == value {
			return true
		}
	}
	return false
}

// modelOptions lists the engine's models once per process; the catalog
// does not change while an agent runs.
func (a *Agent) modelOptions() []SelectOption {
	a.mu.Lock()
	cached := a.models
	a.mu.Unlock()
	if cached != nil {
		return cached
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	res, err := a.engine.Send(ctx, map[string]any{"cmd": "list_models"})
	options := []SelectOption{}
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "acp", "list_models failed; model option is empty", map[string]any{"error": err.Error()})
		return options
	}
	data, _ := res["data"].(map[string]any) //nolint:errcheck // a result without data lists nothing
	if raw, ok := data["models"].([]any); ok {
		for _, item := range raw {
			m, ok := item.(map[string]any)
			if !ok {
				continue
			}
			id := str(m, "id")
			if id == "" {
				continue
			}
			name := str(m, "displayName")
			if name == "" {
				name = id
			}
			options = append(options, SelectOption{Value: id, Name: name, Description: str(m, "providerId")})
		}
	}
	sort.SliceStable(options, func(i, j int) bool { return options[i].Name < options[j].Name })
	a.mu.Lock()
	a.models = options
	a.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "acp", "models listed", map[string]any{"count": len(options)})
	return options
}

func (a *Agent) sessionSetConfigOption(params json.RawMessage) (any, *rpcstdio.RPCError) {
	var req SetConfigOptionRequest
	if err := json.Unmarshal(params, &req); err != nil {
		return nil, badParams(err)
	}
	s, rpcErr := a.session(req.SessionID)
	if rpcErr != nil {
		return nil, rpcErr
	}
	var value string
	if err := json.Unmarshal(req.Value, &value); err != nil {
		return nil, badParams(err)
	}
	switch req.ConfigID {
	case ConfigModel:
		s.mu.Lock()
		s.model = value
		s.mu.Unlock()
		utils.LogWithFields(utils.LevelInfo, "acp", "model set", map[string]any{"session_id": s.id, "model": value})
	case ConfigProfile:
		if h := a.opts.Harness; h != nil {
			return nil, fmtErr("this agent serves the %s harness; its profile cannot change", h.Name)
		}
		if err := s.switchProfile(value); err != nil {
			return nil, internalError(err)
		}
	default:
		return nil, fmtErr("unknown config option: %s", req.ConfigID)
	}
	options := s.configOptions()
	a.notify(s.id, SessionUpdate{SessionUpdate: UpdateConfigOption, ConfigOptions: options})
	return SetConfigOptionResponse{ConfigOptions: options}, nil
}

// switchProfile restarts the engine session with another extension set.
// The key is kept, so the conversation continues under the new harness.
func (s *Session) switchProfile(ref string) error {
	s.mu.Lock()
	if s.turn != nil {
		s.mu.Unlock()
		return fmtErr("cannot change the profile while a prompt is running")
	}
	previous := s.profileID
	s.mu.Unlock()
	var next string
	if p := s.agent.findProfile(ref); p != nil {
		next = p.ID
	}
	if next == previous {
		return nil
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	defer cancel()
	if _, err := s.agent.engine.Send(ctx, map[string]any{"cmd": "stop_session", "key": s.id}); err != nil {
		return err
	}
	s.mu.Lock()
	s.profileID = next
	s.commands = nil
	s.mu.Unlock()
	if err := s.start(ctx, true); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, "acp", "profile switched", map[string]any{"session_id": s.id, "from": previous, "to": next})
	return nil
}

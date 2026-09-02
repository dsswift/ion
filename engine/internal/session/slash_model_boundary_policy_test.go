package session

import (
	"testing"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
)

func TestEvaluateSlashModelBoundaryPolicy(t *testing.T) {
	const key = "boundary-policy"
	makeManager := func() (*Manager, *engineSession) {
		s := &engineSession{key: key, lastModel: "current-model"}
		m := &Manager{sessions: map[string]*engineSession{key: s}}
		return m, s
	}
	makeHistorical := func(t *testing.T, m *Manager, s *engineSession) {
		t.Helper()
		conv := conversation.CreateConversation(conversation.NewConversationID(), "", "current-model")
		conversation.AddUserMessage(conv, "prior turn")
		if err := conversation.Save(conv, ""); err != nil {
			t.Fatalf("Save conversation: %v", err)
		}
		s.conversationID = conv.ID
		m.sessions[key] = s
	}
	res := &ResolvedSlash{Command: "/review", Model: "reasoning"}

	t.Run("fresh applies", func(t *testing.T) {
		m, s := makeManager()
		got := m.evaluateSlashModelBoundary(s, key, res, &types.RunOptions{Model: "current-model"})
		if !got.applied || !got.freshBoundary {
			t.Fatalf("decision = %+v, want applied fresh", got)
		}
	})

	t.Run("default with history retains model", func(t *testing.T) {
		m, s := makeManager()
		makeHistorical(t, m, s)
		got := m.evaluateSlashModelBoundary(s, key, res, &types.RunOptions{Model: "current-model"})
		if got.applied || got.freshBoundary {
			t.Fatalf("decision = %+v, want refused with history", got)
		}
	})

	t.Run("config permits", func(t *testing.T) {
		m, s := makeManager()
		makeHistorical(t, m, s)
		m.config = &types.EngineRuntimeConfig{SlashModelTier: &types.SlashModelTierConfig{ApplyMidConversation: true}}
		got := m.evaluateSlashModelBoundary(s, key, res, &types.RunOptions{Model: "current-model"})
		if !got.applied {
			t.Fatalf("decision = %+v, want config apply", got)
		}
	})

	t.Run("prompt override beats config", func(t *testing.T) {
		m, s := makeManager()
		makeHistorical(t, m, s)
		m.config = &types.EngineRuntimeConfig{SlashModelTier: &types.SlashModelTierConfig{ApplyMidConversation: false}}
		allow := true
		got := m.evaluateSlashModelBoundary(s, key, res, &types.RunOptions{Model: "current-model", SlashModelTierApplyMidConversation: &allow})
		if !got.applied {
			t.Fatalf("decision = %+v, want prompt apply", got)
		}
	})

	t.Run("hook has final say", func(t *testing.T) {
		m, s := makeManager()
		makeHistorical(t, m, s)
		host := extension.NewHost()
		deny := false
		host.SDK().On(extension.HookBeforeSlashModelBoundary, func(_ *extension.Context, _ interface{}) (interface{}, error) {
			return extension.SlashModelBoundaryResult{Apply: &deny}, nil
		})
		group := extension.NewExtensionGroup()
		group.Add(host)
		s.extGroup = group
		allow := true
		got := m.evaluateSlashModelBoundary(s, key, res, &types.RunOptions{Model: "current-model", SlashModelTierApplyMidConversation: &allow})
		if got.applied {
			t.Fatalf("decision = %+v, want hook refusal", got)
		}
	})
}

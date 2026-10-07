package session

import (
	"context"

	"github.com/dsswift/ion/engine/internal/utils"
)

// sessionKeyForCredentialAsk picks the session whose client is asked for a
// credential on behalf of subject.
//
// The session running the work is the one that can answer: its context names
// it (utils.SessionIDFromContext), and the client attached to that session is
// the one acting for the turn's principal. A session's own principal is not
// that person when the session was created before anyone signed in (a server
// that opens a first conversation at boot stamps it with the host's local
// identity), yet the turn runs for the signed-in person through a per-turn
// principal. Matching on the session principal alone would then find no
// session to ask, and the credential would never be requested at all.
//
// The session named by the context is used whenever it exists. Only a call
// that carries no session (an entitlement read, a model list) falls back to
// finding a session attributed to subject, as before.
func (m *Manager) sessionKeyForCredentialAsk(ctx context.Context, subject string) string {
	if subject == "" {
		return ""
	}
	if key := utils.SessionIDFromContext(ctx); key != "" {
		m.mu.RLock()
		_, ok := m.sessions[key]
		m.mu.RUnlock()
		if ok {
			utils.LogWithFields(utils.LevelDebug, "session", "credential request: asking the session running the work", map[string]any{
				"key": key, "subject": subject,
			})
			return key
		}
		utils.LogWithFields(utils.LevelDebug, "session", "credential request: context session is not live; matching by subject", map[string]any{
			"key": key, "subject": subject,
		})
	}
	return m.sessionKeyForSubject(subject)
}

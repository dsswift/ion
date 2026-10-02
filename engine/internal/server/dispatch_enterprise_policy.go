package server

import (
	"net"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/protocol"
	"github.com/dsswift/ion/engine/internal/utils"
)

// dispatchGetEnterprisePolicy returns the full enterprise policy (D-004).
// The engine is the single authoritative reader of MDM/system-level config
// sources (registry, plist, env, drop-ins); clients receive the merged
// EnterpriseConfig here instead of parsing OS-specific sources themselves.
// The blob is a DUMB passthrough: client-specific configuration lives under
// customFields keyed by convention (e.g. customFields["ion-desktop"]) and the
// engine neither validates nor interprets it — ownership of those keys is the
// client's. newConversationDefaults stays duplicated as a top-level key for
// consumers built against the original single-policy response shape
// (additive evolution: existing decoders keep working, new consumers read the
// full policy).
//
// The policy is the one that applies to cmd.Principal: every account policy
// matching that principal is composed in, and the reply never carries the
// account policy list itself. With no principal the reply is the policy the
// engine process runs under.
func (s *Server) dispatchGetEnterprisePolicy(conn net.Conn, cmd *protocol.ClientCommand) {
	var newConversationDefaults interface{}
	var enterprisePolicy interface{}
	if s.config != nil && s.config.Enterprise != nil {
		resolved := ionconfig.ResolveEnterpriseForPrincipal(s.config.Enterprise, cmd.Principal)
		enterprisePolicy = resolved
		if resolved.NewConversationDefaults != nil {
			newConversationDefaults = resolved.NewConversationDefaults
		}
	}
	utils.LogWithFields(utils.LevelDebug, "server", "enterprise policy read", map[string]any{
		"has_policy": enterprisePolicy != nil, "attributed": cmd.Principal != nil,
	})
	s.sendResult(conn, cmd, nil, map[string]interface{}{
		"newConversationDefaults": newConversationDefaults,
		"policy":                  enterprisePolicy,
		// policyHash (manifest C2) is a SHA-256 hex digest of the merged
		// policy's canonical JSON. Stable across two calls with an
		// unchanged policy; changes whenever the policy does. Lets a
		// consumer (the server, a client cache) detect a policy change
		// without deep-comparing the whole blob.
		"policyHash": canonicalPolicyHash(enterprisePolicy),
	})
}

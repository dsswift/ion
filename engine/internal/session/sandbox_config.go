package session

import (
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/conversation"
	"github.com/dsswift/ion/engine/internal/sandbox"
	"github.com/dsswift/ion/engine/internal/types"
)

// buildSandboxConfig resolves the per-session *sandbox.Config, wiring
// SecurityConfig.Sandbox (user layer) merged with SandboxEnterpriseConfig
// (enterprise seal: Required forces the sandbox on regardless of the user
// setting; AdditionalDenyPaths is additive). Returns nil when the sandbox is
// not enabled by either layer. The enterprise AdditionalDangerousPatterns are
// not part of this config: they are enforced with the sandbox on or off (see
// compileCommandPatterns).
//
// When principal partitioning is active for this session's principal
// (attributed, enforcement != none), the sandbox additionally denies read
// access to every OTHER partition and the flat root, with an explicit
// exception for the session's own partition -- the OS-level backstop for
// principalboundary.Checker's in-process check, which a sufficiently
// indirect Bash command can defeat.
func buildSandboxConfig(m *Manager, principal *types.SessionPrincipal) *sandbox.Config {
	var userCfg *types.SandboxConfig
	var enterpriseCfg *types.SandboxEnterpriseConfig
	if m.config != nil {
		if m.config.Security != nil {
			userCfg = m.config.Security.Sandbox
		}
		if m.config.Enterprise != nil {
			enterpriseCfg = m.config.Enterprise.Sandbox
		}
	}

	required := enterpriseCfg != nil && enterpriseCfg.Required
	if !userCfg.SandboxConfigEnabled() && !required {
		return nil
	}

	cfg := &sandbox.Config{}
	if userCfg != nil {
		cfg.Filesystem.DenyRead = append(cfg.Filesystem.DenyRead, userCfg.DenyRead...)
		cfg.Filesystem.DenyWrite = append(cfg.Filesystem.DenyWrite, userCfg.DenyWrite...)
		cfg.Filesystem.AllowWrite = append(cfg.Filesystem.AllowWrite, userCfg.AllowWrite...)
		if userCfg.Network != nil {
			cfg.Network.AllowedDomains = append(cfg.Network.AllowedDomains, userCfg.Network.AllowedDomains...)
			cfg.Network.BlockedDomains = append(cfg.Network.BlockedDomains, userCfg.Network.BlockedDomains...)
		}
	}
	if enterpriseCfg != nil {
		cfg.Filesystem.DenyRead = append(cfg.Filesystem.DenyRead, enterpriseCfg.AdditionalDenyPaths...)
	}

	applyPartitioningToSandbox(cfg, principal)
	return cfg
}

// applyPartitioningToSandbox adds the principals/flat-root deny (with the
// session's own partition carved out as a read exception) when partitioning
// is enabled for this session's principal. A no-op for a disabled engine or
// an unattributed session -- there is nothing of the caller's own to carve
// an exception FOR, and denying an unattributed session read access to
// every partition it already cannot see via storage resolution would just
// be redundant noise in the generated profile.
func applyPartitioningToSandbox(cfg *sandbox.Config, principal *types.SessionPrincipal) {
	if !conversation.PartitioningEnabled() || principal == nil || principal.Subject == "" {
		return
	}
	if conversation.PartitioningEnforcement() == types.EnforcementNone {
		return
	}
	root := conversation.PartitionRoot()
	if root == "" {
		return
	}
	principalsRoot := filepath.Join(filepath.Dir(root), "principals")
	ownPartitionDir := filepath.Dir(conversation.PartitionConversationsDir(principal.Subject))

	cfg.Filesystem.DenyRead = append(cfg.Filesystem.DenyRead, principalsRoot, root)
	cfg.Filesystem.AllowRead = append(cfg.Filesystem.AllowRead, ownPartitionDir)
}

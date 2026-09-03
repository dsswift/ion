package session

import (
	"fmt"
	"strings"

	"github.com/dsswift/ion/engine/internal/auth"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type identityRequirement string

const (
	identityOptional identityRequirement = "optional"
	identityOperator identityRequirement = "operator"
	identityWorkload identityRequirement = "workload"
	identityAny      identityRequirement = "any"
)

type identityPolicy struct {
	requirement identityRequirement
	extensions  []string
}

func (m *Manager) preflightIdentityPolicy(key string, config types.EngineConfig) ([]extension.ResolvedExtensionPlan, identityPolicy, error) {
	utils.LogWithFields(utils.LevelInfo, "session.identity", "extension identity preflight started", map[string]any{"key": key, "count": len(config.Extensions)})
	plans, err := extension.PreflightExtensions(config.Extensions)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.identity", "extension identity preflight refused", map[string]any{"key": key, "error": err.Error()})
		return nil, identityPolicy{}, err
	}
	m.mu.RLock()
	requireOperator := m.config != nil && m.config.Auth != nil && m.config.Auth.RequireOperatorIdentity
	m.mu.RUnlock()
	policy, err := identityPolicyFor(plans, requireOperator)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "session.identity", "extension identity preflight refused", map[string]any{"key": key, "error": err.Error()})
		return nil, identityPolicy{}, err
	}
	if err := policy.check(key, "session admission"); err != nil {
		return nil, identityPolicy{}, err
	}
	utils.LogWithFields(utils.LevelInfo, "session.identity", "extension identity preflight accepted", map[string]any{"key": key, "requirement": policy.requirement, "extensions": policy.extensions, "count": len(plans)})
	return plans, policy, nil
}

func identityPolicyFor(plans []extension.ResolvedExtensionPlan, requireOperator bool) (identityPolicy, error) {
	policy := identityPolicy{requirement: identityOptional}
	if requireOperator {
		policy.requirement = identityOperator
		policy.extensions = append(policy.extensions, "auth.requireOperatorIdentity")
	}
	var operatorExtensions, workloadExtensions []string
	if requireOperator {
		operatorExtensions = append(operatorExtensions, "auth.requireOperatorIdentity")
	}
	for _, plan := range plans {
		requirement := identityOptional
		if plan.Manifest != nil && plan.Manifest.Identity != nil {
			requirement = identityRequirement(plan.Manifest.Identity.Required)
		}
		switch requirement {
		case identityOptional:
		case identityOperator:
			operatorExtensions = append(operatorExtensions, plan.Identifier)
		case identityWorkload:
			workloadExtensions = append(workloadExtensions, plan.Identifier)
		case identityAny:
			if policy.requirement == identityOptional {
				policy.requirement = identityAny
			}
			policy.extensions = append(policy.extensions, plan.Identifier)
		}
	}
	if len(operatorExtensions) > 0 && len(workloadExtensions) > 0 {
		contributors := append(operatorExtensions, workloadExtensions...)
		return identityPolicy{}, fmt.Errorf("incompatible extension identity requirements: operator and workload required by %s", strings.Join(contributors, ", "))
	}
	if len(operatorExtensions) > 0 {
		policy.requirement = identityOperator
		policy.extensions = operatorExtensions
	}
	if len(workloadExtensions) > 0 {
		policy.requirement = identityWorkload
		policy.extensions = workloadExtensions
	}
	return policy, nil
}

func (p identityPolicy) check(key, operation string) error {
	identity := currentSessionIdentity()
	allowed := p.requirement == identityOptional || (p.requirement == identityAny && identity != nil) ||
		(identity != nil && identity.Kind == string(p.requirement))
	fields := map[string]any{"key": key, "operation": operation, "requirement": p.requirement, "extensions": p.extensions, "identity_present": identity != nil}
	if identity != nil {
		fields["identity_kind"] = identity.Kind
	}
	if allowed {
		utils.LogWithFields(utils.LevelInfo, "session.identity", "identity requirement accepted", fields)
		return nil
	}
	utils.LogWithFields(utils.LevelWarn, "session.identity", "identity requirement refused", fields)
	if p.requirement == identityAny {
		return fmt.Errorf("session requires a verified identity for %s (%s)", operation, strings.Join(p.extensions, ", "))
	}
	return fmt.Errorf("session requires verified %s identity for %s (%s)", p.requirement, operation, strings.Join(p.extensions, ", "))
}

func currentSessionIdentity() *auth.ContextIdentity {
	provider := auth.CurrentContextIdentityProvider()
	if provider == nil {
		return nil
	}
	return provider.ContextIdentity()
}

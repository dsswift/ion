package session

import (
	"errors"

	ionconfig "github.com/dsswift/ion/engine/internal/config"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// managedPolicyAbsentErrorCode is the engine_error code for work refused
// because the installation is managed and has no enterprise policy.
const managedPolicyAbsentErrorCode = "managed_policy_absent"

// errManagedPolicyAbsent is returned for every prompt while the lock holds.
var errManagedPolicyAbsent = errors.New("this installation is managed but no enterprise policy was found; prompts are refused until policy is restored")

// managedConfigInvalidErrorCode is the engine_error code for work refused
// because a declared managed config file did not apply.
const managedConfigInvalidErrorCode = "managed_config_invalid"

// errManagedConfigInvalid is returned for every prompt while a declared
// managed config file is not applied.
var errManagedConfigInvalid = errors.New("managed configuration could not be applied; prompts are refused until it is restored")

// managedLocked reports whether the engine is locked: the installation is
// marked managed and no machine policy resolved. Takes m.mu, so the caller
// must not hold it.
func (m *Manager) managedLocked() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config != nil && ionconfig.ManagedPolicyAbsent(m.config.Enterprise)
}

// policyError wraps cause as the Policy Failure id, worded by the enterprise
// policy's message for it when one is configured. Takes m.mu, so the caller
// must not hold it.
func (m *Manager) policyError(id string, cause error) *types.PolicyError {
	m.mu.RLock()
	messages := m.policyMessagesLocked()
	m.mu.RUnlock()
	return ionconfig.NewPolicyError(messages, id, cause)
}

// policyMessagesLocked returns the enterprise policy's message map. The
// caller holds m.mu.
func (m *Manager) policyMessagesLocked() map[string]string {
	if m.config == nil {
		return nil
	}
	return ionconfig.EnterpriseMessages(m.config.Enterprise)
}

// managedConfigError returns why a declared managed config file is not
// applied, or "". Takes m.mu, so the caller must not hold it.
func (m *Manager) managedConfigError() string {
	m.mu.RLock()
	defer m.mu.RUnlock()
	if m.config == nil {
		return ""
	}
	return ionconfig.ManagedConfigError(m.config.Enterprise)
}

// rejectIfManagedLocked refuses a prompt on a locked engine. It runs before a
// run is reserved, so there is nothing to unwind.
func (m *Manager) rejectIfManagedLocked(key string) error {
	if reason := m.managedConfigError(); reason != "" {
		utils.LogWithFields(utils.LevelWarn, "session", "prompt refused: managed config not applied", map[string]any{"key": key, "reason": reason})
		m.emit(key, types.EngineEvent{
			Type:         "engine_error",
			EventMessage: errManagedConfigInvalid.Error() + " (" + reason + ")",
			ErrorCode:    managedConfigInvalidErrorCode,
		})
		return errManagedConfigInvalid
	}
	if !m.managedLocked() {
		return nil
	}
	utils.LogWithFields(utils.LevelWarn, "session", "prompt refused: managed installation has no enterprise policy", map[string]any{"key": key})
	refusal := m.policyError(types.PolicyFailureManagedPolicyAbsent, errManagedPolicyAbsent)
	m.emit(key, types.EngineEvent{
		Type:          "engine_error",
		EventMessage:  refusal.Message,
		ErrorCode:     managedPolicyAbsentErrorCode,
		PolicyFailure: refusal.Failure,
	})
	return refusal
}

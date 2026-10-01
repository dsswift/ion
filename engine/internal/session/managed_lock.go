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

// managedLocked reports whether the engine is locked: the installation is
// marked managed and no machine policy resolved. Takes m.mu, so the caller
// must not hold it.
func (m *Manager) managedLocked() bool {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.config != nil && ionconfig.ManagedPolicyAbsent(m.config.Enterprise)
}

// rejectIfManagedLocked refuses a prompt on a locked engine. It runs before a
// run is reserved, so there is nothing to unwind.
func (m *Manager) rejectIfManagedLocked(key string) error {
	if !m.managedLocked() {
		return nil
	}
	utils.LogWithFields(utils.LevelWarn, "session", "prompt refused: managed installation has no enterprise policy", map[string]any{"key": key})
	m.emit(key, types.EngineEvent{
		Type:         "engine_error",
		EventMessage: errManagedPolicyAbsent.Error(),
		ErrorCode:    managedPolicyAbsentErrorCode,
	})
	return errManagedPolicyAbsent
}

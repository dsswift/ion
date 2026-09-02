package session

import (
	"fmt"
	"time"
)

// forkReservation owns one in-flight fork target key. Pointer identity prevents
// a failed request from releasing a newer reservation for the same key.
type forkReservation struct {
	sourceKey string
}

type forkInitialState struct {
	planMode                    bool
	planModeTools               []string
	planModeAllowedBashCommands []string
	planModeAllowedMcpTools     []string
	planFilePath                string
	hasExitedPlanMode           bool
}

func (m *Manager) reserveForkKey(sourceKey, requestedKey string) (string, *forkReservation, error) {
	m.mu.Lock()
	defer m.mu.Unlock()

	targetKey := requestedKey
	if targetKey == "" {
		for suffix := time.Now().UnixMilli(); ; suffix++ {
			candidate := fmt.Sprintf("%s-fork-%d", sourceKey, suffix)
			if _, active := m.sessions[candidate]; active {
				continue
			}
			if _, reserved := m.forkReservations[candidate]; reserved {
				continue
			}
			targetKey = candidate
			break
		}
	} else {
		if _, active := m.sessions[targetKey]; active {
			return "", nil, sessionKeyExistsError(targetKey)
		}
		if _, reserved := m.forkReservations[targetKey]; reserved {
			return "", nil, sessionKeyExistsError(targetKey)
		}
	}

	reservation := &forkReservation{sourceKey: sourceKey}
	m.forkReservations[targetKey] = reservation
	return targetKey, reservation, nil
}

func (m *Manager) releaseForkKey(targetKey string, reservation *forkReservation) bool {
	m.mu.Lock()
	defer m.mu.Unlock()
	if m.forkReservations[targetKey] != reservation {
		return false
	}
	delete(m.forkReservations, targetKey)
	return true
}

func sessionKeyExistsError(key string) error {
	return &sessionKeyConflictError{key: key}
}

type sessionKeyConflictError struct {
	key string
}

func (e *sessionKeyConflictError) Error() string {
	return "session \"" + e.key + "\" already exists"
}

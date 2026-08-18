package session

import (
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

type recoveryJob struct {
	key        string
	recoveryID string
	enqueuedAt time.Time
	run        func()
}

// recoveryCoordinator is a FIFO, bounded admission queue for restart work.
// Each job revalidates session ownership in its own dispatch function before it
// starts provider work, so stop and key reuse cancel stale entries safely.
type recoveryCoordinator struct {
	mu     sync.Mutex
	jobs   []recoveryJob
	active int
	limit  int
}

func (m *Manager) recoveryConcurrency() int {
	if m.config != nil && m.config.RunRecovery != nil && m.config.RunRecovery.MaxConcurrent > 0 {
		return m.config.RunRecovery.MaxConcurrent
	}
	return types.RunRecoveryDefaultMaxConcurrent
}

func (m *Manager) enqueueRecovery(key, recoveryID string, run func()) {
	m.mu.Lock()
	if m.recoveryCoordinator == nil {
		m.recoveryCoordinator = &recoveryCoordinator{limit: m.recoveryConcurrency()}
	}
	coordinator := m.recoveryCoordinator
	m.mu.Unlock()
	coordinator.enqueue(recoveryJob{key: key, recoveryID: recoveryID, enqueuedAt: time.Now(), run: run})
}

func (c *recoveryCoordinator) enqueue(job recoveryJob) {
	c.mu.Lock()
	c.jobs = append(c.jobs, job)
	depth := len(c.jobs)
	c.startLocked()
	c.mu.Unlock()
	utils.LogWithFields(utils.LevelInfo, "session.recovery", "recovery queued", map[string]any{"key": job.key, "recovery_id": job.recoveryID, "queue_depth": depth})
}

func (c *recoveryCoordinator) startLocked() {
	for c.active < c.limit && len(c.jobs) > 0 {
		job := c.jobs[0]
		c.jobs = c.jobs[1:]
		c.active++
		go func() {
			defer func() {
				c.mu.Lock()
				c.active--
				c.startLocked()
				c.mu.Unlock()
			}()
			utils.LogWithFields(utils.LevelInfo, "session.recovery", "recovery queue job starting", map[string]any{"key": job.key, "recovery_id": job.recoveryID, "wait_ms": time.Since(job.enqueuedAt).Milliseconds()})
			job.run()
		}()
	}
}

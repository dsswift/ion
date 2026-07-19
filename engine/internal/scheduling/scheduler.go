// Package scheduling implements the engine-internal scheduler that
// fires registered ScheduleJob declarations on their configured
// cadence.
//
// Architecture mirrors the webhook server (see engine/internal/webhooks):
//
//   - Scheduler is a per-session-manager singleton. Hosts are added /
//     removed dynamically as extensions load; the scheduler reads each
//     host's asyncreg registry to enumerate jobs.
//   - One tick loop ticks every second (TickInterval). On each tick,
//     the loop walks every host's schedule registry, fires every job
//     whose next-run is ≤ now, and updates the in-memory next-run map.
//   - Per-fire arbitration: an in-process sync.Map prevents two
//     concurrent fires of the same (host, jobId). The plan calls for
//     cross-subprocess flock arbitration; that's deferred to a future
//     iteration since the engine currently runs as a single process.
//     (When a daemon-mode engine sits behind multiple desktop clients,
//     they share a process, so in-process arbitration is sufficient.)
//   - Last-run markers are persisted to disk under ~/.ion/scheduler so
//     daily/weekly catch-up survives engine restarts.
//
// The scheduler is the trigger source only — every downstream concern
// (session resolution, ctx injection, handler dispatch) is shared with
// the webhook server via host.FireAsync.
package scheduling

import (
	"encoding/json"
	"fmt"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/asyncreg"
	"github.com/dsswift/ion/engine/internal/extension"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// TickInterval is the scheduler's main loop cadence. 1s is the
// engineered floor for daily/weekly resolution (any finer would
// over-trigger near minute boundaries) and the documented minimum
// IntervalMs for interval jobs.
const TickInterval = time.Second

// DefaultFireTimeout caps a schedule handler invocation. Generous so
// extensions can dispatch agents inside the handler. Interval jobs may
// override via ScheduleJob.TimeoutMs.
const DefaultFireTimeout = 60 * time.Second

// CatchUpStagger is the additional delay the scheduler applies to
// missed daily/weekly jobs when a restart triggers catch-up. Spreads
// fires across a 30s window so a restart with 10 jobs doesn't fire
// them all at once.
const CatchUpStagger = 30 * time.Second

// SessionResolver matches the webhook server's resolver: given a host,
// return a fresh extension.Context for the bound session. Wired by the
// session manager.
type SessionResolver func(host *extension.Host) (*extension.Context, error)

// Scheduler is the engine-internal job runner. New() constructs but
// does not start; Start() launches the tick loop; Stop() signals
// shutdown and waits for the loop to exit.
type Scheduler struct {
	cfg Config

	mu       sync.RWMutex
	hosts    []*extension.Host
	emit     func(types.EngineEvent)
	resolve  SessionResolver
	running  bool
	stopCh   chan struct{}
	doneCh   chan struct{}
	nextRun  map[hostJobKey]time.Time
	// extNextRun tracks the most recent nextRun value by logical job identity
	// (extensionName + jobID) independent of host pointer. Updated whenever a
	// host-keyed nextRun entry is set, and consulted by bootstrapNextRun when
	// a new host is bootstrapped for a job that was previously tracked by a
	// now-removed host. This preserves interval cadence across host-pointer
	// replacements (session teardown + recreation).
	extNextRun map[extensionJobKey]time.Time
	inFlight   sync.Map // hostJobKey -> struct{}

	// persistDir is the directory under which last-run markers are
	// persisted. Empty means no persistence (tests / catch-up
	// disabled).
	persistDir string

	// nowFn is a test-injectable clock. nil means real time.Now.
	nowFn func() time.Time

	// resolveEnabledFnForTest, when non-nil, overrides the enabled-predicate
	// resolution path (resolveEnabledPredicate). Only used in tests — allows
	// deterministic predicate simulation without a live subprocess.
	resolveEnabledFnForTest func(h *extension.Host, job extension.ScheduleJob) (bool, error)
}

// hostJobKey scopes a job by its owning host pointer plus the job id.
// Two hosts can use the same job id without interfering.
type hostJobKey struct {
	host *extension.Host
	id   string
}

// extensionJobKey groups jobs by extension name + job ID for
// concurrency coordination. All hosts of the same extension with the
// same job ID share one extensionJobKey.
type extensionJobKey struct {
	name string // host.Name()
	id   string // job.JobID
}

// hostJobEntry pairs a host with a job for the group-then-fire pass.
type hostJobEntry struct {
	host *extension.Host
	job  extension.ScheduleJob
}

// Config holds the engine-config-controlled defaults for the
// scheduler. All fields zero-valued to inherit engine defaults.
type Config struct {
	// DefaultTz is the IANA timezone applied to daily/weekly jobs
	// whose ScheduleJob.Tz is empty. Empty inherits the system local
	// timezone.
	DefaultTz string
	// FireTimeout is the per-fire handler timeout default. Zero falls
	// back to DefaultFireTimeout. Per-job override is the job's
	// TimeoutMs.
	FireTimeout time.Duration
	// CatchUpEnabled controls whether missed daily/weekly fires fire on
	// engine startup. Nil treats as default-on.
	CatchUpEnabled *bool
	// PersistDir is the directory for last-run markers. Empty disables
	// persistence (catch-up still works on a per-process basis).
	PersistDir string
}

// New constructs a Scheduler with the given Config.
func New(cfg Config) *Scheduler {
	return &Scheduler{
		cfg:        cfg,
		nextRun:    make(map[hostJobKey]time.Time),
		extNextRun: make(map[extensionJobKey]time.Time),
		persistDir: cfg.PersistDir,
	}
}

// SetEmit wires the session emitter for engine_schedule_* events.
func (s *Scheduler) SetEmit(fn func(types.EngineEvent)) {
	s.mu.Lock()
	s.emit = fn
	s.mu.Unlock()
}

// SetSessionResolver wires the per-fire session-resolution callback.
func (s *Scheduler) SetSessionResolver(fn SessionResolver) {
	s.mu.Lock()
	s.resolve = fn
	s.mu.Unlock()
}

// SetResolveEnabledFnForTest injects a test override for enabled-predicate
// resolution so tests can exercise the disabled/enabled skip path without
// needing a live extension subprocess. Production code never calls this.
func (s *Scheduler) SetResolveEnabledFnForTest(fn func(h *extension.Host, job extension.ScheduleJob) (bool, error)) {
	s.mu.Lock()
	s.resolveEnabledFnForTest = fn
	s.mu.Unlock()
}

// siblingNextRun returns the most-recently-recorded nextRun value for a given
// (extensionName, jobID) pair regardless of which host pointer set it. Returns
// zero if no value has ever been recorded for this logical job identity.
// Used by bootstrapNextRun to inherit interval cadence across host-pointer
// replacements (session teardown + recreation).
func (s *Scheduler) siblingNextRun(extKey extensionJobKey) time.Time {
	s.mu.RLock()
	defer s.mu.RUnlock()
	return s.extNextRun[extKey]
}

// AddHost adds a host whose schedule registry will be polled by the
// tick loop. Idempotent.
func (s *Scheduler) AddHost(h *extension.Host) {
	if h == nil {
		return
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, existing := range s.hosts {
		if existing == h {
			return
		}
	}
	s.hosts = append(s.hosts, h)
	utils.LogWithFields(utils.LevelDebug, "scheduling", "add host", map[string]any{"model": h.Name(), "count": len(s.hosts)})
}

// RemoveHost removes a host from the schedule pool. In-flight fires
// for that host continue to completion; new fires won't dispatch.
// When removing the last alive host for a registered (extension, jobID)
// group, emits engine_schedule_unhosted so consumers can observe the
// transition to host-less and alert on silent gaps.
func (s *Scheduler) RemoveHost(h *extension.Host) {
	if h == nil {
		return
	}
	s.mu.Lock()

	var unhostingJobs []extension.ScheduleJob
	for i, existing := range s.hosts {
		if existing != h {
			continue
		}
		s.hosts = append(s.hosts[:i], s.hosts[i+1:]...)

		// Drop next-run entries for jobs we're no longer tracking.
		for k := range s.nextRun {
			if k.host == h {
				delete(s.nextRun, k)
			}
		}

		// Detect job groups that now have zero alive hosts remaining.
		// For each job the departing host registered, check whether any
		// surviving host in s.hosts still carries the same (name, jobID).
		decls := h.AsyncRegistry().List(asyncreg.KindSchedule)
		for _, d := range decls {
			job, ok := d.(extension.ScheduleJob)
			if !ok {
				continue
			}
			extKey := extensionJobKey{name: h.Name(), id: job.JobID}
			hasAlive := false
			for _, peer := range s.hosts {
				if peer.Dead() {
					continue
				}
				if _, found := peer.AsyncRegistry().ByID(asyncreg.KindSchedule, job.JobID); found {
					if peer.Name() == extKey.name {
						hasAlive = true
						break
					}
				}
			}
			if !hasAlive {
				unhostingJobs = append(unhostingJobs, job)
			}
		}

		utils.LogWithFields(utils.LevelDebug, "scheduling", "remove host", map[string]any{"model": h.Name(), "count": len(s.hosts)})
		break
	}
	s.mu.Unlock()

	// Emit unhosted events outside the lock (publish acquires s.mu.RLock).
	for _, job := range unhostingJobs {
		utils.LogWithFields(utils.LevelWarn, "scheduling", "schedule group unhosted — no alive hosts remain", map[string]any{
			"model": h.Name(), "run_id": job.JobID, "kind": string(job.Kind),
		})
		s.emitScheduleUnhosted(job)
	}
}

// Start launches the tick loop. Idempotent — calling Start when
// already running is a no-op.
func (s *Scheduler) Start() {
	s.mu.Lock()
	if s.running {
		s.mu.Unlock()
		return
	}
	s.running = true
	s.stopCh = make(chan struct{})
	s.doneCh = make(chan struct{})
	s.mu.Unlock()

	utils.LogWithFields(utils.LevelInfo, "scheduling", "start", map[string]any{
		"duration_ms": TickInterval.Milliseconds(), "max": s.fireTimeout(), "reason": s.defaultTz(), "path": s.persistDir,
	})

	go s.runLoop()
}

// Stop signals the tick loop to exit and waits for it to finish.
// Idempotent.
func (s *Scheduler) Stop() {
	s.mu.Lock()
	if !s.running {
		s.mu.Unlock()
		return
	}
	stopCh := s.stopCh
	doneCh := s.doneCh
	s.running = false
	s.mu.Unlock()

	close(stopCh)
	<-doneCh
	utils.Log("scheduler", "Stop: tick loop exited")
}

// runLoop is the scheduler's main goroutine. Ticks once per
// TickInterval, walks every host's schedule registry, fires every
// job whose next-run is ≤ now, and updates the in-memory next-run.
func (s *Scheduler) runLoop() {
	defer close(s.doneCh)
	ticker := time.NewTicker(TickInterval)
	defer ticker.Stop()
	// Initial pass on startup so a freshly-registered job whose first
	// run is ≤ now fires without waiting a full tick.
	s.tickOnce()
	for {
		select {
		case <-s.stopCh:
			return
		case <-ticker.C:
			s.tickOnce()
		}
	}
}

// tickOnce performs a single pass over every registered job. Jobs are
// grouped by (extensionName, jobID) for concurrency coordination.
// In "single" mode (the default), only the first alive host in each
// group fires. In "all" mode, every host fires independently.
// Public for tests so they can step the scheduler deterministically.
func (s *Scheduler) tickOnce() {
	now := s.now()
	s.mu.RLock()
	hosts := append([]*extension.Host(nil), s.hosts...)
	resolve := s.resolve
	s.mu.RUnlock()

	// Group jobs by (extensionName, jobID) for concurrency coordination.
	// Also collect active hostJobKeys so we can prune orphaned nextRun
	// entries left behind by deregistered jobs (e.g. schedule.cancel),
	// plus the alive-host view (extension names + logical job keys) that
	// gates the extNextRun prune below.
	groups := make(map[extensionJobKey][]hostJobEntry)
	activeKeys := make(map[hostJobKey]struct{})
	aliveExtNames := make(map[string]struct{})
	aliveExtKeys := make(map[extensionJobKey]struct{})
	for _, h := range hosts {
		decls := h.AsyncRegistry().List(asyncreg.KindSchedule)
		alive := !h.Dead()
		if alive {
			aliveExtNames[h.Name()] = struct{}{}
		}
		for _, d := range decls {
			job, ok := d.(extension.ScheduleJob)
			if !ok {
				continue
			}
			key := extensionJobKey{name: h.Name(), id: job.JobID}
			groups[key] = append(groups[key], hostJobEntry{host: h, job: job})
			activeKeys[hostJobKey{host: h, id: job.JobID}] = struct{}{}
			if alive {
				aliveExtKeys[key] = struct{}{}
			}
		}
	}

	// Fire each group according to its concurrency mode.
	for _, entries := range groups {
		if len(entries) == 0 {
			continue
		}
		concurrency := entries[0].job.Concurrency
		if concurrency == "all" {
			// All mode: fire on every host (opt-in behavior).
			for _, e := range entries {
				s.maybeFire(e.host, e.job, now, resolve)
			}
		} else {
			// Single mode (default): fire on the first alive host only.
			for _, e := range entries {
				if !e.host.Dead() {
					s.maybeFire(e.host, e.job, now, resolve)
					break
				}
			}
		}
	}

	// Prune orphaned nextRun entries. When schedule.cancel removes a
	// job from the host registry, the scheduler's nextRun map retains
	// the stale entry. A re-registered job with the same ID would
	// inherit the old next-run time and fire immediately.
	s.mu.Lock()
	for key := range s.nextRun {
		if _, active := activeKeys[key]; !active {
			delete(s.nextRun, key)
		}
	}
	// Prune orphaned extNextRun entries — the same cancel→re-register
	// staleness, one layer up. extNextRun is keyed by logical job identity
	// so bootstrapNextRun can inherit interval cadence across host-pointer
	// replacement (#285); without a prune, a job cancelled and later
	// re-registered under the same ID inherits the stale — possibly past —
	// next-run and fires immediately, and the map grows for the life of
	// the daemon. The gate distinguishes the two states:
	//   - Cancelled: at least one ALIVE host of that extension exists but
	//     none of them carries the job → the entry is stale, prune it.
	//   - Host-replacement window: NO alive host of that extension exists
	//     → the entry is load-bearing (it is exactly what the successor
	//     host inherits on bootstrap) — keep it.
	for extKey := range s.extNextRun {
		if _, jobAlive := aliveExtKeys[extKey]; jobAlive {
			continue // job still registered on an alive host — keep.
		}
		if _, extAlive := aliveExtNames[extKey.name]; !extAlive {
			continue // replacement window: no alive host yet — keep for inherit.
		}
		delete(s.extNextRun, extKey)
		utils.LogWithFields(utils.LevelDebug, "scheduling", "prune orphaned extNextRun entry", map[string]any{
			"model": extKey.name, "run_id": extKey.id,
		})
	}
	s.mu.Unlock()
}

// maybeFire decides whether a job's next-run has elapsed and, if so,
// schedules a goroutine to dispatch the fire. Returns immediately if
// not yet due, currently in-flight, or just registered (next-run not
// yet computed).
func (s *Scheduler) maybeFire(h *extension.Host, job extension.ScheduleJob, now time.Time, resolve SessionResolver) {
	key := hostJobKey{host: h, id: job.JobID}
	s.mu.RLock()
	next, computed := s.nextRun[key]
	s.mu.RUnlock()
	if !computed {
		// First sighting — compute next-run, possibly run catch-up,
		// and store. Don't fire on this tick; the next tick will pick
		// it up if applicable.
		s.bootstrapNextRun(h, job, now)
		return
	}
	if now.Before(next) {
		return
	}
	if _, busy := s.inFlight.LoadOrStore(key, struct{}{}); busy {
		// A previous fire is still running; skip this tick to avoid
		// overlap. Log so the operator sees the overlap.
		utils.LogWithFields(utils.LevelInfo, "scheduling", "maybe fire skip previous in flight", map[string]any{"model": h.Name(), "run_id": job.JobID})
		return
	}
	if resolve == nil {
		s.inFlight.Delete(key)
		s.emitScheduleSkipped(job, "no_resolver")
		utils.LogWithFields(utils.LevelError, "scheduling", "maybe fire no resolver wired", map[string]any{"model": h.Name(), "run_id": job.JobID})
		s.advanceNextRun(key, job, now)
		return
	}
	go s.fireJob(h, job, key, resolve)
}

// fireJob runs the handler invocation for a single tick. Blocks until
// the subprocess responds or the timeout elapses; releases the
// in-flight slot before returning.
//
// For once jobs: unlike interval/daily/weekly, we do NOT advance the
// next-run entry before the handler fires. After a successful or failed
// handler invocation (the real-fire path, not the predicate-skip path),
// the job is deregistered via h.DeregisterScheduleDecl so the tick loop
// never revisits it. The predicate-skip path returns before the handler
// runs, so a once job whose predicate returns false remains armed for
// the next tick — it has NOT spent its shot.
func (s *Scheduler) fireJob(h *extension.Host, job extension.ScheduleJob, key hostJobKey, resolve SessionResolver) {
	defer s.inFlight.Delete(key)
	now := s.now()

	// For repeating jobs: advance next-run BEFORE the fire so a slow
	// handler doesn't cause overlapping fires on the next tick. The
	// in-flight guard is the second layer. For once jobs we skip this
	// — the job will be deregistered after the handler fires instead.
	if job.Kind != extension.ScheduleOnce {
		s.advanceNextRun(key, job, now)
	}

	ctx, err := resolve(h)
	if err != nil || ctx == nil {
		s.emitScheduleSkipped(job, "no_session")
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job session resolve failed", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": err.Error()})
		// For once jobs a session-resolve failure is not a spent shot —
		// leave the next-run entry in place so the job retries next tick.
		// For repeating jobs the next-run has already been advanced above.
		return
	}

	// Optional enable-predicate callback. A false result is a skip, NOT
	// a fire — the once job remains armed for the next tick.
	if job.EnabledRefName != "" {
		enabled, err := s.resolveEnabledPredicate(h, job)
		if err != nil {
			utils.LogWithFields(utils.LevelError, "scheduling", "fire job enabled predicate failed", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": err.Error()})
			// Treat predicate failure as "skipped, reason=predicate_error".
			s.emitScheduleSkipped(job, "predicate_error")
			return
		}
		if !enabled {
			s.emitScheduleSkipped(job, "disabled")
			utils.LogWithFields(utils.LevelDebug, "scheduling", "fire job skipped disabled", map[string]any{"model": h.Name(), "run_id": job.JobID})
			return
		}
	}

	timeout := s.fireTimeoutForJob(job)
	utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job", map[string]any{"model": h.Name(), "run_id": job.JobID, "reason": job.Kind, "duration_ms": timeout.Milliseconds()})
	startTs := s.now()
	payload := map[string]interface{}{
		"firedAt": startTs.UTC().Format(time.RFC3339),
	}
	_, err = h.FireAsync(asyncreg.KindSchedule, job.JobID, ctx, payload, timeout)
	elapsed := s.now().Sub(startTs)
	if err != nil {
		s.emitScheduleFailed(job, err.Error(), elapsed)
		utils.LogWithFields(utils.LevelError, "scheduling", "fire job handler error", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": err.Error(), "duration_ms": elapsed.Milliseconds()})
		// Handler failed — for once jobs, still deregister: the shot was
		// spent (handler was invoked, even though it errored). Fall through
		// to the once-deregister block below.
	} else {
		s.recordLastRun(h, job, startTs)
		s.emitScheduleFired(job, elapsed)
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job completed", map[string]any{"model": h.Name(), "run_id": job.JobID, "duration_ms": elapsed.Milliseconds()})
	}

	// Once jobs self-deregister after the handler has run (whether it
	// succeeded or failed). Remove the registry entry and the next-run
	// map entry so no subsequent tick ever revisits this job.
	if job.Kind == extension.ScheduleOnce {
		ok := h.DeregisterScheduleDeclSilent(job.JobID)
		if ok {
			// Drop the next-run entry so the tick loop doesn't revisit.
			s.mu.Lock()
			delete(s.nextRun, key)
			// Also drop the logical-identity cadence entry: a once job is
			// spent, so a future job registered under the same ID must
			// bootstrap fresh, not inherit this shot's next-run.
			delete(s.extNextRun, extensionJobKey{name: h.Name(), id: job.JobID})
			s.mu.Unlock()
			s.emitScheduleDeregistered(job, "once_complete")
			utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job once deregistered", map[string]any{"model": h.Name(), "run_id": job.JobID})
		} else {
			// Registry entry was already gone (concurrent deregister by the
			// extension itself). Log but don't treat as an error.
			utils.LogWithFields(utils.LevelError, "scheduling", "fire job once deregister returned false already gone", map[string]any{"model": h.Name(), "run_id": job.JobID})
		}
	}
}

// resolveEnabledPredicate calls back into the subprocess to evaluate
// the job's `() => bool` enabled predicate. Returns the predicate
// result, or an error if the RPC fails. Mirrors Host.ResolveToken's
// shape — short timeout, tolerant decoder.
//
// In tests, resolveEnabledFnForTest can be wired to bypass the
// subprocess round-trip and return a deterministic result.
func (s *Scheduler) resolveEnabledPredicate(h *extension.Host, job extension.ScheduleJob) (bool, error) {
	s.mu.RLock()
	overrideFn := s.resolveEnabledFnForTest
	s.mu.RUnlock()
	if overrideFn != nil {
		return overrideFn(h, job)
	}
	raw, err := h.ResolvePredicate(job.EnabledRefName)
	if err != nil {
		return false, err
	}
	if len(raw) == 0 || string(raw) == "null" {
		return true, nil
	}
	var asObj struct {
		Enabled bool `json:"enabled"`
	}
	if err := json.Unmarshal(raw, &asObj); err == nil {
		return asObj.Enabled, nil
	}
	var asBool bool
	if err := json.Unmarshal(raw, &asBool); err == nil {
		return asBool, nil
	}
	return false, fmt.Errorf("resolveEnabledPredicate: unrecognised response: %s", string(raw))
}

// FireScheduleNow triggers an immediate fire of the named job on host h.
// Honors in-flight + single-concurrency arbitration. Returns nil on success,
// nil when the job is already in-flight (benign), or an error when the job
// is not found or no resolver is wired.
func (s *Scheduler) FireScheduleNow(h *extension.Host, jobID string) error {
	if h == nil {
		return fmt.Errorf("fire schedule now: nil host")
	}
	// Locate the job declaration on host h's AsyncRegistry.
	decl, found := h.AsyncRegistry().ByID(asyncreg.KindSchedule, jobID)
	if !found {
		return fmt.Errorf("fire schedule now: job %q not found on host %s", jobID, h.Name())
	}
	job, ok := decl.(extension.ScheduleJob)
	if !ok {
		return fmt.Errorf("fire schedule now: job %q has unexpected type", jobID)
	}

	// Determine the target host for concurrency coordination.
	var target *extension.Host
	if job.Concurrency == "all" {
		target = h
	} else {
		// Single (default): first non-dead host that owns this job.
		s.mu.RLock()
		hosts := append([]*extension.Host(nil), s.hosts...)
		s.mu.RUnlock()
		for _, candidate := range hosts {
			if candidate.Dead() {
				continue
			}
			if _, ok := candidate.AsyncRegistry().ByID(asyncreg.KindSchedule, jobID); ok {
				target = candidate
				break
			}
		}
		if target == nil {
			target = h // fallback
		}
	}

	key := hostJobKey{host: target, id: jobID}
	if _, busy := s.inFlight.LoadOrStore(key, struct{}{}); busy {
		// Already in-flight: benign, not an error.
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire schedule now skipped already in flight", map[string]any{"model": target.Name(), "run_id": jobID})
		return nil
	}

	s.mu.RLock()
	resolve := s.resolve
	s.mu.RUnlock()
	if resolve == nil {
		s.inFlight.Delete(key)
		return fmt.Errorf("fire schedule now: no resolver wired")
	}

	go s.fireJobWithMeta(target, job, key, resolve, true, "")
	return nil
}

// fireJobWithMeta is like fireJob but carries optional backfill metadata
// in the payload so the handler can distinguish a manual/backfill fire from
// a live tick fire. When backfill is false, behavior is identical to fireJob.
func (s *Scheduler) fireJobWithMeta(h *extension.Host, job extension.ScheduleJob, key hostJobKey, resolve SessionResolver, backfill bool, missedSlotUtc string) {
	defer s.inFlight.Delete(key)
	now := s.now()

	if job.Kind != extension.ScheduleOnce {
		s.advanceNextRun(key, job, now)
	}

	ctx, err := resolve(h)
	if err != nil || ctx == nil {
		s.emitScheduleSkipped(job, "no_session")
		errMsg := "nil context"
		if err != nil {
			errMsg = err.Error()
		}
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta session resolve failed", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": errMsg})
		return
	}

	if job.EnabledRefName != "" {
		enabled, err := s.resolveEnabledPredicate(h, job)
		if err != nil {
			s.emitScheduleSkipped(job, "predicate_error")
			utils.LogWithFields(utils.LevelError, "scheduling", "fire job with meta predicate failed", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": err.Error()})
			return
		}
		if !enabled {
			s.emitScheduleSkipped(job, "disabled")
			return
		}
	}

	timeout := s.fireTimeoutForJob(job)
	utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta", map[string]any{"model": h.Name(), "run_id": job.JobID, "backfill": backfill})
	startTs := s.now()
	payload := map[string]interface{}{
		"firedAt": startTs.UTC().Format(time.RFC3339),
	}
	if backfill {
		payload["backfill"] = true
		if missedSlotUtc != "" {
			payload["missedSlotUtc"] = missedSlotUtc
		}
	}
	_, err = h.FireAsync(asyncreg.KindSchedule, job.JobID, ctx, payload, timeout)
	elapsed := s.now().Sub(startTs)
	if err != nil {
		s.emitScheduleFailed(job, err.Error(), elapsed)
		utils.LogWithFields(utils.LevelError, "scheduling", "fire job with meta handler error", map[string]any{"model": h.Name(), "run_id": job.JobID, "error": err.Error(), "duration_ms": elapsed.Milliseconds()})
	} else {
		s.recordLastRun(h, job, startTs)
		s.emitScheduleFired(job, elapsed)
		utils.LogWithFields(utils.LevelInfo, "scheduling", "fire job with meta completed", map[string]any{"model": h.Name(), "run_id": job.JobID, "duration_ms": elapsed.Milliseconds()})
	}

	if job.Kind == extension.ScheduleOnce {
		ok := h.DeregisterScheduleDeclSilent(job.JobID)
		if ok {
			s.mu.Lock()
			delete(s.nextRun, key)
			// Spent shot: drop the logical-identity cadence entry too (see
			// the mirror comment in fireJob's once-deregister block).
			delete(s.extNextRun, extensionJobKey{name: h.Name(), id: job.JobID})
			s.mu.Unlock()
			s.emitScheduleDeregistered(job, "once_complete")
		}
	}
}

// ScheduleStatusFor returns a status entry for a single (host, job) pair.
func (s *Scheduler) ScheduleStatusFor(h *extension.Host, job extension.ScheduleJob, now time.Time) extension.ScheduleStatusEntry {
	name := hostName(h)
	loc := s.loadTz(jobTz(job))

	lastRunUtc := ""
	if lr, ok := s.readLastRunByName(name, job); ok {
		lastRunUtc = lr.UTC().Format(time.RFC3339)
	}

	ranWithinScope := s.lastRunWithinScopeByName(name, job, now, loc)

	nextRunUtc := ""
	key := hostJobKey{host: h, id: job.JobID}
	s.mu.RLock()
	if nr, ok := s.nextRun[key]; ok {
		nextRunUtc = nr.UTC().Format(time.RFC3339)
	}
	s.mu.RUnlock()

	return extension.ScheduleStatusEntry{
		ID:             job.JobID,
		Kind:           string(job.Kind),
		LastRunUtc:     lastRunUtc,
		RanWithinScope: ranWithinScope,
		NextRunUtc:     nextRunUtc,
	}
}

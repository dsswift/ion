package sysmetrics

import (
	"context"
	"runtime"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Compiled defaults. Every one is overridable through SystemMetricsConfig.
const (
	DefaultBackgroundIntervalMs int64 = 30_000
	DefaultMinIntervalMs        int64 = 250
	DefaultTelemetryIntervalMs  int64 = 60_000
	// MaxIntervalMs is the slowest interval a watcher may ask for.
	MaxIntervalMs int64 = 60_000
	// heapWarnFraction is the share of the soft heap ceiling at which a
	// sample is logged at ERROR rather than INFO.
	heapWarnFraction = 0.85
	// sampleTimeout bounds one sample, so a wedged OS call cannot stall the
	// loop forever.
	sampleTimeout = 10 * time.Second
)

// Options configures a Sampler.
type Options struct {
	Config *types.SystemMetricsConfig
	// MemLimitBytes is the soft heap ceiling in effect, reported in every
	// sample and used for the high-memory escalation.
	MemLimitBytes int64
	// Sessions returns the number of live sessions. Nil reports 0.
	Sessions func() int
}

// Listener receives every sample. due lists the watcher ids whose own
// interval elapsed with this sample (empty for a background sample nobody is
// watching). Listeners run on the sampler goroutine and must not block.
type Listener func(sample types.SystemMetricsSample, due []string)

// Sampler takes System Metrics samples on one goroutine: slowly in the
// background, and at the fastest interval any watcher asked for while
// someone is watching.
type Sampler struct {
	backgroundMs  int64
	minMs         int64
	diskPath      string
	memLimitBytes int64
	sessions      func() int

	sampleMu sync.Mutex // serializes readers (they keep previous readings)
	host     *hostReader
	procs    *procReader

	mu         sync.Mutex
	latest     *types.SystemMetricsSample
	listeners  []Listener
	lastInfoMs int64
	intervalMs int64

	watchers *watchSet
	wake     chan struct{}
	stop     chan struct{}
	stopOnce sync.Once
}

// New builds a Sampler. It does not start sampling; call Start.
func New(opts Options) *Sampler {
	cfg := opts.Config
	s := &Sampler{
		backgroundMs:  DefaultBackgroundIntervalMs,
		minMs:         DefaultMinIntervalMs,
		diskPath:      utils.IonDir(),
		memLimitBytes: opts.MemLimitBytes,
		sessions:      opts.Sessions,
		host:          newHostReader(),
		procs:         newProcReader(),
		watchers:      newWatchSet(),
		wake:          make(chan struct{}, 1),
		stop:          make(chan struct{}),
	}
	if cfg != nil {
		if cfg.BackgroundIntervalMs > 0 {
			s.backgroundMs = cfg.BackgroundIntervalMs
		}
		if cfg.MinIntervalMs > 0 {
			s.minMs = cfg.MinIntervalMs
		}
		if cfg.DiskPath != "" {
			s.diskPath = utils.ExpandHomePath(cfg.DiskPath)
		}
	}
	s.intervalMs = s.backgroundMs
	return s
}

// AddListener registers a function that receives every sample.
func (s *Sampler) AddListener(l Listener) {
	s.mu.Lock()
	s.listeners = append(s.listeners, l)
	s.mu.Unlock()
}

// Latest returns the most recent sample, or nil before the first one.
func (s *Sampler) Latest() *types.SystemMetricsSample {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.latest
}

// Current returns the latest sample, taking one immediately when none exists.
func (s *Sampler) Current() types.SystemMetricsSample {
	if l := s.Latest(); l != nil {
		return *l
	}
	return s.SampleNow()
}

// ClampInterval bounds a watcher's requested interval.
func (s *Sampler) ClampInterval(ms int64) int64 {
	if ms < s.minMs {
		return s.minMs
	}
	if ms > MaxIntervalMs {
		return MaxIntervalMs
	}
	return ms
}

// Watch starts (or updates) a watcher and returns the interval it will
// receive samples at. intervalMs <= 0 stops watching and returns 0.
func (s *Sampler) Watch(id string, intervalMs int64) int64 {
	if intervalMs <= 0 {
		s.Unwatch(id)
		return 0
	}
	eff := s.ClampInterval(intervalMs)
	s.watchers.set(id, eff)
	utils.LogWithFields(utils.LevelInfo, "sysmetrics", "watcher set", map[string]any{
		"connection_id": id, "interval_ms": eff, "requested_interval_ms": intervalMs, "watchers": s.watchers.count(),
	})
	s.poke()
	return eff
}

// Unwatch stops a watcher. Safe for an id that is not watching.
func (s *Sampler) Unwatch(id string) {
	if !s.watchers.remove(id) {
		return
	}
	utils.LogWithFields(utils.LevelInfo, "sysmetrics", "watcher removed", map[string]any{
		"connection_id": id, "watchers": s.watchers.count(),
	})
	s.poke()
}

// Watchers returns the number of connections watching.
func (s *Sampler) Watchers() int { return s.watchers.count() }

func (s *Sampler) poke() {
	select {
	case s.wake <- struct{}{}:
	default:
	}
}

// currentInterval is the fastest watcher interval, or the background one.
func (s *Sampler) currentInterval() int64 {
	if m := s.watchers.minInterval(); m > 0 && m < s.backgroundMs {
		return m
	}
	return s.backgroundMs
}

// Start launches the sampling goroutine. The first sample is taken
// immediately so later samples have a baseline to compute CPU use against.
func (s *Sampler) Start() {
	utils.LogWithFields(utils.LevelInfo, "sysmetrics", "sampler started", map[string]any{
		"background_interval_ms": s.backgroundMs, "min_interval_ms": s.minMs,
		"disk_path": s.diskPath, "mem_limit_bytes": s.memLimitBytes,
	})
	go s.loop()
}

// Stop ends the sampling goroutine. Safe to call more than once.
func (s *Sampler) Stop() {
	s.stopOnce.Do(func() { close(s.stop) })
}

func (s *Sampler) loop() {
	s.tick()
	for {
		interval := s.currentInterval()
		s.mu.Lock()
		changed := interval != s.intervalMs
		s.intervalMs = interval
		s.mu.Unlock()
		if changed {
			utils.LogWithFields(utils.LevelInfo, "sysmetrics", "sampling interval changed", map[string]any{
				"interval_ms": interval, "watchers": s.watchers.count(),
			})
		}
		timer := time.NewTimer(time.Duration(interval) * time.Millisecond)
		select {
		case <-s.stop:
			timer.Stop()
			utils.Log("sysmetrics", "sampler stopped")
			return
		case <-s.wake:
			// A watcher came or went: take a sample now if the new interval
			// is faster, so a new watcher is not left waiting a full
			// background interval for its first sample.
			timer.Stop()
			if s.currentInterval() < interval {
				s.tick()
			}
		case <-timer.C:
			s.tick()
		}
	}
}

// tick takes a sample and hands it to every listener.
func (s *Sampler) tick() {
	sample := s.SampleNow()
	s.mu.Lock()
	listeners := append([]Listener(nil), s.listeners...)
	tickMs := s.intervalMs
	s.mu.Unlock()
	due := s.watchers.due(sample.SampledAt, tickMs)
	for _, l := range listeners {
		l(sample, due)
	}
}

// SampleNow takes one sample synchronously, stores it as the latest, and
// logs it.
func (s *Sampler) SampleNow() types.SystemMetricsSample {
	ctx, cancel := context.WithTimeout(context.Background(), sampleTimeout)
	defer cancel()

	s.sampleMu.Lock()
	start := time.Now()
	now := start.UnixMilli()
	host := s.host.read(ctx, s.diskPath)
	procs := s.procs.read(ctx, now)
	s.sampleMu.Unlock()

	var ms runtime.MemStats
	runtime.ReadMemStats(&ms)
	sessions := 0
	if s.sessions != nil {
		sessions = s.sessions()
	}
	s.mu.Lock()
	interval := s.intervalMs
	s.mu.Unlock()

	sample := types.SystemMetricsSample{
		SampledAt:  now,
		IntervalMs: interval,
		Host:       host,
		Processes:  procs,
		Runtime: types.SystemMetricsRuntime{
			HeapBytes:     ms.HeapAlloc,
			SysBytes:      ms.Sys,
			MemLimitBytes: s.memLimitBytes,
			Goroutines:    runtime.NumGoroutine(),
			NumGC:         ms.NumGC,
			Sessions:      sessions,
		},
	}
	s.mu.Lock()
	s.latest = &sample
	logInfo := now-s.lastInfoMs >= s.backgroundMs
	if logInfo {
		s.lastInfoMs = now
	}
	s.mu.Unlock()
	s.logSample(sample, logInfo, time.Since(start))
	return sample
}

// logSample writes one sample to engine.jsonl. Every sample is logged at
// DEBUG; one per background interval is logged at INFO (or ERROR near the
// heap ceiling) so the log carries a steady series whatever the watch
// cadence. Every number is a flat field so LogQL `unwrap` can chart it.
func (s *Sampler) logSample(sample types.SystemMetricsSample, info bool, took time.Duration) {
	fields := SampleLogFields(sample)
	fields["sample_duration_ms"] = took.Milliseconds()
	level := utils.LevelDebug
	msg := "system metrics sample"
	if info {
		level = utils.LevelInfo
		if s.memLimitBytes > 0 && float64(sample.Runtime.HeapBytes) >= float64(s.memLimitBytes)*heapWarnFraction {
			level = utils.LevelError
			msg = "HIGH MEMORY"
		}
	}
	utils.LogWithFields(level, "sysmetrics", msg, fields)
}

// SampleLogFields flattens a sample into log fields: every value a
// top-level number with its unit in the name, plus per-role process sums.
func SampleLogFields(sample types.SystemMetricsSample) map[string]any {
	const mib = 1024 * 1024
	h, r := sample.Host, sample.Runtime
	f := map[string]any{
		"interval_ms":                 sample.IntervalMs,
		"host_cpu_count":              h.CPUCount,
		"host_effective_cpu_count":    h.EffectiveCPUCount,
		"host_memory_total_bytes":     h.MemoryTotalBytes,
		"host_memory_available_bytes": h.MemoryAvailableBytes,
		"host_memory_limit_bytes":     h.MemoryLimitBytes,
		"host_container_limited":      h.ContainerLimited,
		"host_disk_total_bytes":       h.DiskTotalBytes,
		"host_disk_free_bytes":        h.DiskFreeBytes,
		"heap_bytes":                  r.HeapBytes,
		"sys_bytes":                   r.SysBytes,
		"mem_limit_bytes":             r.MemLimitBytes,
		"heap_mb":                     r.HeapBytes / mib,
		"sys_mb":                      r.SysBytes / mib,
		"limit_mb":                    r.MemLimitBytes / mib,
		"goroutines":                  r.Goroutines,
		"num_gc":                      r.NumGC,
		"sessions":                    r.Sessions,
		"process_count":               len(sample.Processes),
	}
	if h.CPUUtilization != nil {
		f["host_cpu_utilization"] = *h.CPUUtilization
	}
	if h.Load1 != nil {
		f["host_load1"] = *h.Load1
	}
	cpu := map[string]float64{}
	rss := map[string]uint64{}
	for _, p := range sample.Processes {
		if p.CPUPercent != nil {
			cpu[p.Role] += *p.CPUPercent
		}
		rss[p.Role] += p.RSSBytes
	}
	for _, role := range []string{
		types.SystemMetricsRoleEngine, types.SystemMetricsRoleExtension, types.SystemMetricsRoleMcp,
		types.SystemMetricsRoleBackend, types.SystemMetricsRoleTool,
	} {
		f[role+"_cpu_percent"] = cpu[role]
		f[role+"_rss_bytes"] = rss[role]
	}
	return f
}

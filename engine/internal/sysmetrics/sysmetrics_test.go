package sysmetrics

import (
	"context"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/shirou/gopsutil/v4/cpu"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

func TestHostCPUUtilization(t *testing.T) {
	prev := cpu.TimesStat{User: 10, System: 10, Idle: 80}
	cur := cpu.TimesStat{User: 15, System: 15, Idle: 90}
	u, ok := hostCPUUtilization(prev, cur)
	if !ok || u != 0.5 {
		t.Fatalf("normal: got %v %v, want 0.5 true", u, ok)
	}
	if _, ok := hostCPUUtilization(cur, prev); ok {
		t.Fatal("counters went backwards: want ok=false")
	}
	if _, ok := hostCPUUtilization(cur, cur); ok {
		t.Fatal("zero elapsed: want ok=false")
	}
	// Steal counts as busy: a guest whose time was stolen was not free.
	u, ok = hostCPUUtilization(cpu.TimesStat{Idle: 10}, cpu.TimesStat{Idle: 15, Steal: 5})
	if !ok || u != 0.5 {
		t.Fatalf("steal: got %v %v, want 0.5 true", u, ok)
	}
}

func TestProcessCPUPercent(t *testing.T) {
	if p, ok := processCPUPercent(1000, 1500, 0, 1000); !ok || p != 50 {
		t.Fatalf("got %v %v, want 50 true", p, ok)
	}
	if p, ok := processCPUPercent(0, 2000, 0, 1000); !ok || p != 200 {
		t.Fatalf("two cores: got %v %v, want 200 true", p, ok)
	}
	if _, ok := processCPUPercent(1500, 1000, 0, 1000); ok {
		t.Fatal("cpu time went backwards: want ok=false")
	}
	if _, ok := processCPUPercent(0, 10, 1000, 1000); ok {
		t.Fatal("zero elapsed: want ok=false")
	}
}

func writeCgroup(t *testing.T, files map[string]string) string {
	t.Helper()
	dir := t.TempDir()
	for name, body := range files {
		if err := os.WriteFile(filepath.Join(dir, name), []byte(body+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	return dir
}

func TestReadCgroupLimits(t *testing.T) {
	l := readCgroupLimits(writeCgroup(t, map[string]string{
		"memory.max": "2147483648", "memory.current": "536870912", "cpu.max": "150000 100000",
	}))
	if l.memoryMaxBytes != 2<<30 || l.memoryCurrentBytes != 512<<20 || l.cpuQuota != 1.5 {
		t.Fatalf("limited: got %+v", l)
	}
	l = readCgroupLimits(writeCgroup(t, map[string]string{"memory.max": "max", "cpu.max": "max 100000"}))
	if l.memoryMaxBytes != 0 || l.cpuQuota != 0 {
		t.Fatalf("unlimited: got %+v", l)
	}
	if l := readCgroupLimits(t.TempDir()); l != (cgroupLimits{}) {
		t.Fatalf("missing files: got %+v", l)
	}
}

func TestApplyCgroupLimits(t *testing.T) {
	h := hostFigures{cpuCount: 8, effectiveCPU: 8, memoryTotal: 16 << 30, memoryAvailable: 10 << 30}
	applyCgroupLimits(&h, cgroupLimits{memoryMaxBytes: 2 << 30, memoryCurrentBytes: 1 << 30, cpuQuota: 1.5})
	if !h.containerLimited || h.memoryLimit != 2<<30 || h.memoryAvailable != 1<<30 || h.effectiveCPU != 1.5 {
		t.Fatalf("got %+v", h)
	}
	// A limit above the host's own figures narrows nothing.
	h = hostFigures{cpuCount: 2, effectiveCPU: 2, memoryTotal: 4 << 30, memoryAvailable: 3 << 30}
	applyCgroupLimits(&h, cgroupLimits{memoryMaxBytes: 64 << 30, cpuQuota: 16})
	if h.containerLimited || h.memoryLimit != 0 || h.effectiveCPU != 2 {
		t.Fatalf("loose limits changed figures: %+v", h)
	}
}

func TestWalkTreeKeepsOnlyDescendants(t *testing.T) {
	parents := map[int32]int32{1: 0, 10: 1, 11: 10, 12: 10, 13: 11, 20: 1, 21: 20}
	got := walkTree(10, parents)
	want := []int32{10, 11, 12, 13}
	if len(got) != len(want) {
		t.Fatalf("got %v, want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("got %v, want %v", got, want)
		}
	}
}

func TestRegistryRoleAndPidReuse(t *testing.T) {
	registryMu.Lock()
	registry[4242] = registration{role: types.SystemMetricsRoleExtension, name: "cos2", startMs: 1000}
	registryMu.Unlock()
	t.Cleanup(func() { UnregisterProcess(4242) })

	if r, ok := lookupRegistration(4242, 1000); !ok || r.role != "extension" || r.name != "cos2" {
		t.Fatalf("same process: got %+v %v", r, ok)
	}
	if _, ok := lookupRegistration(4242, 2000); ok {
		t.Fatal("a reused pid with a different start time must not inherit the role")
	}
	pruneRegistry(map[int32]bool{})
	if _, ok := lookupRegistration(4242, 1000); ok {
		t.Fatal("prune must drop a pid that left the tree")
	}
}

// TestProcReaderLabelsOwnTree runs the reader against the real process table
// with a real child, so the registry, the walk and the per-process reads are
// exercised together.
func TestProcReaderLabelsOwnTree(t *testing.T) {
	r := newProcReader()
	child := startSleeper(t)
	RegisterProcess(child, types.SystemMetricsRoleMcp, "fixture-server")
	t.Cleanup(func() { UnregisterProcess(child) })

	rows := r.read(context.Background(), time.Now().UnixMilli())
	roles := map[int32]types.SystemMetricsProcess{}
	for _, p := range rows {
		roles[p.Pid] = p
	}
	if got := roles[int32(os.Getpid())]; got.Role != types.SystemMetricsRoleEngine {
		t.Fatalf("own process role = %q, want engine", got.Role)
	}
	if got := roles[int32(child)]; got.Role != types.SystemMetricsRoleMcp || got.Name != "fixture-server" {
		t.Fatalf("registered child = %+v, want mcp/fixture-server", got)
	}
	if roles[int32(os.Getpid())].CPUPercent != nil {
		t.Fatal("first sample of a process has no CPU baseline")
	}
	rows = r.read(context.Background(), time.Now().UnixMilli()+1000)
	for _, p := range rows {
		if p.Pid == int32(os.Getpid()) && p.CPUPercent == nil {
			t.Fatal("second sample must carry CPU use")
		}
	}
}

func TestWatchSetCadence(t *testing.T) {
	w := newWatchSet()
	if w.minInterval() != 0 {
		t.Fatal("no watchers: min interval must be 0")
	}
	w.set("a", 1000)
	w.set("b", 250)
	if w.minInterval() != 250 {
		t.Fatalf("min = %d, want 250", w.minInterval())
	}
	// On a 250 ms tick, b is due every tick and a every fourth.
	var aCount int
	for i := int64(1); i <= 8; i++ {
		for _, id := range w.due(i*250, 250) {
			if id == "a" {
				aCount++
			}
		}
	}
	if aCount != 2 {
		t.Fatalf("1000 ms watcher delivered %d times in 2 s, want 2", aCount)
	}
	if !w.remove("b") || w.minInterval() != 1000 {
		t.Fatal("removing the fast watcher must slow the cadence")
	}
	if w.remove("b") {
		t.Fatal("removing twice must report false")
	}
}

func TestSamplerWatchLifecycle(t *testing.T) {
	s := New(Options{Config: &types.SystemMetricsConfig{BackgroundIntervalMs: 30_000, MinIntervalMs: 100}})
	if got := s.Watch("c1", 10); got != 100 {
		t.Fatalf("clamped interval = %d, want 100", got)
	}
	if got := s.Watch("c2", 5*60_000); got != MaxIntervalMs {
		t.Fatalf("clamped interval = %d, want %d", got, MaxIntervalMs)
	}
	if s.currentInterval() != 100 {
		t.Fatalf("interval with watchers = %d, want 100", s.currentInterval())
	}
	s.Unwatch("c1")
	if got := s.Watch("c2", 0); got != 0 {
		t.Fatal("interval 0 must stop watching")
	}
	if s.Watchers() != 0 || s.currentInterval() != 30_000 {
		t.Fatalf("after last watcher left: watchers=%d interval=%d", s.Watchers(), s.currentInterval())
	}
}

func TestSamplerDeliversToWatchers(t *testing.T) {
	s := New(Options{Config: &types.SystemMetricsConfig{BackgroundIntervalMs: 60_000, MinIntervalMs: 50}})
	got := make(chan []string, 16)
	s.AddListener(func(_ types.SystemMetricsSample, due []string) { got <- due })
	s.Start()
	t.Cleanup(s.Stop)
	<-got // the immediate first sample
	s.Watch("conn-1", 50)
	deadline := time.After(5 * time.Second)
	for {
		select {
		case due := <-got:
			for _, id := range due {
				if id == "conn-1" {
					return
				}
			}
		case <-deadline:
			t.Fatal("a watcher never received a sample")
		}
	}
}

func TestSampleJSONShape(t *testing.T) {
	s := New(Options{MemLimitBytes: 1 << 30, Sessions: func() int { return 3 }})
	sample := s.SampleNow()
	raw, err := json.Marshal(types.EngineEvent{Type: "engine_system_metrics", SystemMetrics: &sample})
	if err != nil {
		t.Fatal(err)
	}
	js := string(raw)
	for _, key := range []string{
		`"systemMetrics":{`, `"sampledAt":`, `"host":{`, `"cpuUtilization":null`, `"memoryTotalBytes":`,
		`"containerLimited":`, `"processes":[`, `"role":"engine"`, `"runtime":{`, `"sessions":3`, `"memLimitBytes":1073741824`,
	} {
		if !strings.Contains(js, key) {
			t.Fatalf("missing %s in %s", key, js)
		}
	}
	if strings.Contains(js, "cmdline") || strings.Contains(js, "args") {
		t.Fatal("a sample must never carry a command line")
	}
}

func TestSampleLogFieldsAreFlat(t *testing.T) {
	cpuPct := 12.5
	util := 0.25
	f := SampleLogFields(types.SystemMetricsSample{
		Host:      types.SystemMetricsHost{CPUUtilization: &util, MemoryAvailableBytes: 42},
		Processes: []types.SystemMetricsProcess{{Role: "mcp", CPUPercent: &cpuPct, RSSBytes: 7}, {Role: "mcp", RSSBytes: 3}},
	})
	if f["host_cpu_utilization"] != 0.25 || f["host_memory_available_bytes"] != uint64(42) {
		t.Fatalf("host fields: %+v", f)
	}
	if f["mcp_cpu_percent"] != 12.5 || f["mcp_rss_bytes"] != uint64(10) || f["tool_rss_bytes"] != uint64(0) {
		t.Fatalf("role sums: %+v", f)
	}
	for k, v := range f {
		switch v.(type) {
		case map[string]any, []any:
			t.Fatalf("field %s is nested; unwrap needs flat numbers", k)
		}
	}
}

// BenchmarkSample measures one full sample: host counters plus the process
// walk. The walk reads the parent table once per sample instead of once per
// process, which is what keeps it cheap on macOS.
func BenchmarkSample(b *testing.B) {
	s := New(Options{})
	for i := 0; i < b.N; i++ {
		s.SampleNow()
	}
}

// captureLevels records each log line's level and message for one test.
func captureLevels(t *testing.T) func() []string {
	t.Helper()
	var mu sync.Mutex
	var lines []string
	utils.SetTestSink(func(level utils.LogLevel, tag, msg string, fields map[string]any, _, _ string) {
		if tag != "sysmetrics" {
			return
		}
		mu.Lock()
		lines = append(lines, fmt.Sprintf("%v %s sessions=%v", level, msg, fields["sessions"]))
		mu.Unlock()
	})
	t.Cleanup(func() { utils.SetTestSink(nil) })
	return func() []string {
		mu.Lock()
		defer mu.Unlock()
		return append([]string(nil), lines...)
	}
}

func TestSampleLogsInfoWithSessions(t *testing.T) {
	get := captureLevels(t)
	s := New(Options{MemLimitBytes: 64 << 30, Sessions: func() int { return 7 }})
	s.SampleNow()
	got := strings.Join(get(), "\n")
	if !strings.Contains(got, fmt.Sprintf("%v system metrics sample sessions=7", utils.LevelInfo)) {
		t.Fatalf("first sample must log at INFO with the session count: %s", got)
	}
	if strings.Contains(got, "HIGH MEMORY") {
		t.Fatalf("no escalation below the ceiling: %s", got)
	}
	// A second sample inside the background interval is not logged at INFO
	// again (it goes to DEBUG, which the test sink may filter by level).
	s.SampleNow()
	infos := 0
	for _, l := range get() {
		if strings.HasPrefix(l, fmt.Sprintf("%v system metrics sample", utils.LevelInfo)) {
			infos++
		}
	}
	if infos != 1 {
		t.Fatalf("INFO samples inside one background interval = %d, want 1", infos)
	}
}

func TestSampleEscalatesNearHeapCeiling(t *testing.T) {
	get := captureLevels(t)
	// A 1-byte ceiling: any running Go program's heap is past 85% of it, so
	// the escalation fires without racing the allocator.
	New(Options{MemLimitBytes: 1, Sessions: func() int { return 3 }}).SampleNow()
	if got := strings.Join(get(), "\n"); !strings.Contains(got, fmt.Sprintf("%v HIGH MEMORY sessions=3", utils.LevelError)) {
		t.Fatalf("expected an ERROR HIGH MEMORY line: %s", got)
	}
}

func TestSampleNilSessionsReportsZero(t *testing.T) {
	get := captureLevels(t)
	New(Options{}).SampleNow()
	if got := strings.Join(get(), "\n"); !strings.Contains(got, "sessions=0") {
		t.Fatalf("nil session count must report 0: %s", got)
	}
}

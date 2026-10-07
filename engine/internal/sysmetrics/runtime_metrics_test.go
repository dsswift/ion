package sysmetrics

import (
	"math"
	"runtime"
	"runtime/metrics"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
)

// The p99 is read off the bucket edge holding the 99th percentile of the
// events recorded since the previous reading; an infinite top edge reports
// the finite edge below it; an interval with nothing recorded is 0.
func TestHistogramP99(t *testing.T) {
	buckets := []float64{0, 0.001, 0.01, 0.1, math.Inf(1)}
	prev := &metrics.Float64Histogram{Buckets: buckets, Counts: []uint64{10, 5, 0, 0}}
	cur := &metrics.Float64Histogram{Buckets: buckets, Counts: []uint64{10, 104, 1, 0}}
	// 100 events in interval: 99 in the 0.001..0.01 bucket, 1 in 0.01..0.1.
	if got := histogramP99(cur, prev); got != 0.01 {
		t.Fatalf("p99 = %v, want 0.01 (the edge of the bucket holding the 99th event)", got)
	}
	if got := histogramP99(cur, cur); got != 0 {
		t.Fatalf("p99 with no events in the interval = %v, want 0", got)
	}
	top := &metrics.Float64Histogram{Buckets: buckets, Counts: []uint64{0, 0, 0, 7}}
	if got := histogramP99(top, nil); got != 0.1 {
		t.Fatalf("p99 in the open top bucket = %v, want the finite edge 0.1", got)
	}
}

// Two readings apart yield interval figures: an allocation rate once the
// program allocates, and non-negative latencies, as the sampler reports them.
func TestRuntimeReaderReportsIntervalFigures(t *testing.T) {
	r := newRuntimeReader()
	if !r.supported {
		t.Skip("this Go runtime lacks one of the metrics")
	}
	first := r.read(time.Now())
	if first != (runtimeFigures{}) {
		t.Fatalf("first reading must be zero (nothing to compare with): %+v", first)
	}
	sink := make([][]byte, 0, 64)
	for i := 0; i < 64; i++ {
		sink = append(sink, make([]byte, 64<<10))
	}
	runtime.GC()
	runtime.KeepAlive(sink)
	second := r.read(time.Now().Add(time.Second))
	if second.allocRateBytesPerS <= 0 {
		t.Fatalf("alloc rate after allocating = %v, want > 0", second.allocRateBytesPerS)
	}
	if second.gcPauseP99Ms < 0 || second.schedLatencyP99Ms < 0 {
		t.Fatalf("latencies must be non-negative: %+v", second)
	}
	fields := SampleLogFields(types.SystemMetricsSample{Runtime: types.SystemMetricsRuntime{
		GCPauseP99Ms: second.gcPauseP99Ms, AllocRateBytesPerS: second.allocRateBytesPerS, SchedLatencyP99Ms: second.schedLatencyP99Ms,
	}})
	for _, key := range []string{"gc_pause_p99_ms", "alloc_rate_bytes_per_s", "sched_latency_p99_ms"} {
		if _, ok := fields[key]; !ok {
			t.Fatalf("log fields lack %s: %v", key, fields)
		}
	}
}

// A spawn site that names a session has it on the registration, and a plain
// RegisterProcess has none.
func TestRegisterSessionProcessKeepsSession(t *testing.T) {
	RegisterSessionProcess(999_901, types.SystemMetricsRoleExtension, "ext-a", "sess-a")
	RegisterProcess(999_902, types.SystemMetricsRoleMcp, "fs")
	t.Cleanup(func() { UnregisterProcess(999_901); UnregisterProcess(999_902) })
	a, ok := lookupRegistration(999_901, 0)
	if !ok || a.sessionID != "sess-a" || a.role != types.SystemMetricsRoleExtension {
		t.Fatalf("registration = %+v, %v", a, ok)
	}
	b, ok := lookupRegistration(999_902, 0)
	if !ok || b.sessionID != "" {
		t.Fatalf("plain registration = %+v, %v; want no session", b, ok)
	}
}

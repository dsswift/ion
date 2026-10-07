package sysmetrics

import (
	"math"
	"runtime/metrics"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// runtime/metrics sample names. Each is a cumulative figure since process
// start; the reader differences consecutive readings so every sample reports
// the interval just ended, which is what a dashboard charts.
const (
	gcPausesMetric     = "/gc/pauses:seconds"
	heapAllocsMetric   = "/gc/heap/allocs:bytes"
	schedLatencyMetric = "/sched/latencies:seconds"
	runtimeP99         = 0.99
	secondsToMillis    = 1000.0
)

// runtimeFigures is one sample's view of the Go runtime: p99s over the
// interval and an allocation rate. Zero values mean nothing happened in the
// interval, or (first sample) there is no previous reading to compare with.
type runtimeFigures struct {
	gcPauseP99Ms       float64
	allocRateBytesPerS float64
	schedLatencyP99Ms  float64
}

// runtimeReader reads runtime/metrics and remembers the previous reading so
// cumulative histograms and counters become per-interval figures.
type runtimeReader struct {
	samples   []metrics.Sample
	supported bool
	prevAt    time.Time
	prevGC    *metrics.Float64Histogram
	prevSched *metrics.Float64Histogram
	prevAlloc uint64
	hasPrev   bool
}

// newRuntimeReader checks that this Go runtime exposes the three metrics; a
// runtime that lacks one reports zeros for every figure and logs it once.
func newRuntimeReader() *runtimeReader {
	r := &runtimeReader{samples: []metrics.Sample{
		{Name: gcPausesMetric}, {Name: heapAllocsMetric}, {Name: schedLatencyMetric},
	}}
	known := map[string]bool{}
	for _, d := range metrics.All() {
		known[d.Name] = true
	}
	r.supported = true
	for _, s := range r.samples {
		if !known[s.Name] {
			r.supported = false
			utils.LogWithFields(utils.LevelWarn, "sysmetrics", "runtime metric unavailable; runtime figures report zero", map[string]any{"metric": s.Name})
		}
	}
	return r
}

// read takes one reading at now and returns the interval figures against the
// previous reading. Caller holds Sampler.sampleMu.
func (r *runtimeReader) read(now time.Time) runtimeFigures {
	if !r.supported {
		return runtimeFigures{}
	}
	metrics.Read(r.samples)
	// Kinds are checked before the typed accessors: an accessor on the
	// wrong kind panics, and a runtime that changed a metric's kind must
	// degrade to zeros, not take the sampler down.
	gcV, allocV, schedV := r.samples[0].Value, r.samples[1].Value, r.samples[2].Value
	if gcV.Kind() != metrics.KindFloat64Histogram || allocV.Kind() != metrics.KindUint64 || schedV.Kind() != metrics.KindFloat64Histogram {
		utils.LogWithFields(utils.LevelWarn, "sysmetrics", "runtime metric kind unexpected; runtime figures report zero", map[string]any{
			"gc_kind": gcV.Kind(), "alloc_kind": allocV.Kind(), "sched_kind": schedV.Kind(),
		})
		return runtimeFigures{}
	}
	gc, alloc, sched := gcV.Float64Histogram(), allocV.Uint64(), schedV.Float64Histogram()
	var out runtimeFigures
	if r.hasPrev {
		out.gcPauseP99Ms = histogramP99(gc, r.prevGC) * secondsToMillis
		out.schedLatencyP99Ms = histogramP99(sched, r.prevSched) * secondsToMillis
		if dt := now.Sub(r.prevAt).Seconds(); dt > 0 && alloc >= r.prevAlloc {
			out.allocRateBytesPerS = float64(alloc-r.prevAlloc) / dt
		}
	}
	r.prevGC, r.prevSched, r.prevAlloc, r.prevAt, r.hasPrev = cloneHistogram(gc), cloneHistogram(sched), alloc, now, true
	return out
}

// cloneHistogram copies a histogram's counts; metrics.Read reuses the
// backing arrays on the next call.
func cloneHistogram(h *metrics.Float64Histogram) *metrics.Float64Histogram {
	if h == nil {
		return nil
	}
	return &metrics.Float64Histogram{
		Counts:  append([]uint64(nil), h.Counts...),
		Buckets: append([]float64(nil), h.Buckets...),
	}
}

// histogramP99 is the p99 of the events cur recorded since prev, read off the
// bucket boundaries (the upper edge of the bucket holding the 99th
// percentile). The histograms must share bucket layout, which runtime/metrics
// guarantees for one metric within one process. 0 when nothing was recorded
// in the interval; an infinite top edge reports the finite edge below it.
func histogramP99(cur, prev *metrics.Float64Histogram) float64 {
	if cur == nil || len(cur.Counts) == 0 || len(cur.Buckets) != len(cur.Counts)+1 {
		return 0
	}
	delta := make([]uint64, len(cur.Counts))
	var total uint64
	for i, c := range cur.Counts {
		if prev != nil && len(prev.Counts) == len(cur.Counts) && prev.Counts[i] <= c {
			c -= prev.Counts[i]
		}
		delta[i] = c
		total += c
	}
	if total == 0 {
		return 0
	}
	target := uint64(math.Ceil(float64(total) * runtimeP99))
	var seen uint64
	for i, c := range delta {
		seen += c
		if seen >= target {
			edge := cur.Buckets[i+1]
			if math.IsInf(edge, 1) {
				return cur.Buckets[i]
			}
			return edge
		}
	}
	return cur.Buckets[len(cur.Buckets)-1]
}

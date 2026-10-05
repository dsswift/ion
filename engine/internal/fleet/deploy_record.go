package fleet

import (
	"path/filepath"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A deploy's record: what is being deployed, to which hosts, and where each
// stands now. The fleet keeps it current from the deploy's own events and
// tells this machine's server, which shows it in Studio and passes it to the
// Fleet Hubs it reports to. Its JSON is packages/shared types-fleet-deploy.ts.

// States of a deploy.
const (
	DeployRunning   = "running"
	DeployDone      = "done"
	DeployFailed    = "failed"
	DeployCancelled = "cancelled"
)

// DeployRecord is one deploy.
type DeployRecord struct {
	ID string `json:"id"`
	// Source says what is deployed, for a person: "build of ion", "release 1.2.3".
	Source string `json:"source"`
	// StartedAt, UpdatedAt, and EndedAt are Unix milliseconds.
	StartedAt int64                `json:"startedAt"`
	UpdatedAt int64                `json:"updatedAt"`
	EndedAt   int64                `json:"endedAt,omitempty"`
	State     string               `json:"state"`
	Targets   []DeployRecordTarget `json:"targets"`
}

// DeployRecordTarget is one host of a deploy.
type DeployRecordTarget struct {
	Host string `json:"host"`
	// EnvironmentID is the host's catalog id, when it has one.
	EnvironmentID string `json:"environmentId,omitempty"`
	Label         string `json:"label"`
	Component     string `json:"component,omitempty"`
	// Platform is goos/goarch, when known.
	Platform string `json:"platform,omitempty"`
	// Stage is the host's Stage now; Detail its one-line explanation.
	Stage     string `json:"stage"`
	Detail    string `json:"detail,omitempty"`
	UpdatedAt int64  `json:"updatedAt"`
	// Error is why a failed host failed.
	Error string `json:"error,omitempty"`
}

// DeployTracker keeps a deploy's record current and hands each new version
// of it to post.
type DeployTracker struct {
	mu     sync.Mutex
	record DeployRecord
	post   func(DeployRecord)
	now    func() time.Time
}

// NewDeployTracker starts a record for a prepared deploy.
func NewDeployTracker(id string, p *Prepared, post func(DeployRecord)) *DeployTracker {
	t := &DeployTracker{post: post, now: time.Now}
	at := t.now().UnixMilli()
	source := "release"
	if p.Request.Source == SourceDev {
		source = "build of " + filepath.Base(p.Request.Checkout)
		if p.Request.Artifact != "" {
			source = filepath.Base(p.Request.Artifact)
		}
	} else if v := firstNonEmptyString(p.Latest.Desktop, p.Latest.Server); v != "" {
		source = "release " + v
	}
	t.record = DeployRecord{ID: id, Source: source, StartedAt: at, UpdatedAt: at, State: DeployRunning}
	for _, target := range p.Targets {
		h := target.Host
		rt := DeployRecordTarget{Host: h.Name, Label: firstNonEmptyString(h.Label, h.Name), Component: target.Component, Stage: StageQueued, UpdatedAt: at}
		if h.Entry != nil {
			rt.EnvironmentID = h.Entry.EnvironmentID
		}
		if target.GOOS != "" {
			rt.Platform = target.GOOS + "/" + target.GOARCH
		}
		t.record.Targets = append(t.record.Targets, rt)
	}
	return t
}

// Record is the record as it stands.
func (t *DeployTracker) Record() DeployRecord {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.snapshot()
}

func (t *DeployTracker) snapshot() DeployRecord {
	r := t.record
	r.Targets = append([]DeployRecordTarget(nil), t.record.Targets...)
	return r
}

// publish posts the record; callers hold mu.
func (t *DeployTracker) publish() {
	t.record.UpdatedAt = t.now().UnixMilli()
	if t.post != nil {
		t.post(t.snapshot())
	}
}

// Start posts the record as it begins.
func (t *DeployTracker) Start() {
	t.mu.Lock()
	defer t.mu.Unlock()
	t.publish()
}

// Beat posts the record unchanged, which says the deploy is still running.
func (t *DeployTracker) Beat() {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.record.State == DeployRunning {
		t.publish()
	}
}

// Event applies one step of the deploy.
func (t *DeployTracker) Event(e Event) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := t.now().UnixMilli()
	for i := range t.record.Targets {
		rt := &t.record.Targets[i]
		if rt.Host != e.Host {
			continue
		}
		rt.Stage, rt.Detail, rt.UpdatedAt, rt.Error = e.Stage, e.Detail, at, ""
		if e.Stage == StageFailed {
			rt.Error, rt.Detail = e.Detail, ""
		}
	}
	t.publish()
}

// Finish closes the record: every host's outcome, and the deploy's own. A
// host the deploy never reached ends failed, with why.
func (t *DeployTracker) Finish(results []Result, cancelled bool, runErr error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	at := t.now().UnixMilli()
	byHost := map[string]Result{}
	for _, r := range results {
		byHost[r.Host] = r
	}
	failed := runErr != nil
	for i := range t.record.Targets {
		rt := &t.record.Targets[i]
		r, reached := byHost[rt.Host]
		switch {
		case reached && r.OK:
			if rt.Stage != StageDone {
				rt.Stage, rt.Detail = StageDone, ""
			}
			rt.Error = ""
		case reached:
			rt.Stage, rt.Detail, rt.Error = StageFailed, "", r.Error
			failed = true
		case rt.Stage != StageDone && rt.Stage != StageFailed:
			why := "the deploy stopped before this host finished"
			if runErr != nil {
				why = runErr.Error()
			}
			rt.Stage, rt.Detail, rt.Error = StageFailed, "", why
			failed = true
		case rt.Stage == StageFailed:
			failed = true
		}
		rt.UpdatedAt = at
	}
	switch {
	case cancelled:
		t.record.State = DeployCancelled
	case failed:
		t.record.State = DeployFailed
	default:
		t.record.State = DeployDone
	}
	t.record.EndedAt = at
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy record closed", map[string]any{"deploy_id": t.record.ID, "state": t.record.State, "targets": len(t.record.Targets)})
	t.publish()
}

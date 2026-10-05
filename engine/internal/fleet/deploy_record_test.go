package fleet

import (
	"context"
	"errors"
	"strings"
	"sync"
	"testing"
	"time"
)

type recordSink struct {
	mu      sync.Mutex
	records []DeployRecord
}

func (s *recordSink) post(r DeployRecord) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.records = append(s.records, r)
}

func (s *recordSink) last() DeployRecord {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.records[len(s.records)-1]
}

// A tracked deploy posts its record at the start, on every step, and at the
// end, where each host has its outcome and the deploy its own.
func TestRunTracked_PostsTheRecordAsTheDeployRuns(t *testing.T) {
	onMac(t)
	cfg := Config{Checkout: fakeCheckout(t), Hosts: []Host{
		{Name: "mac", Label: "The Mac", SSH: "mac", Kind: KindServer, Entry: &Entry{EnvironmentID: "env-mac"}},
		{Name: "win", SSH: "win", Kind: KindDesktop},
	}}
	f, d := builderFixture(t, cfg, map[string]string{"win": "go\n"})
	f.platform["mac"], f.platform["win"] = "Darwin arm64", "Windows arm64"
	var seen []string
	d.Progress = func(e Event) {
		f.mu.Lock()
		seen = append(seen, e.Host+":"+e.Stage)
		f.mu.Unlock()
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: cfg.Hosts, Source: SourceDev, Checkout: cfg.Checkout, ForceSSH: true})
	if err != nil {
		t.Fatal(err)
	}
	sink := &recordSink{}
	if _, err := d.RunTracked(context.Background(), p, "deploy-1", sink.post); err != nil {
		t.Fatal(err)
	}
	first, last := sink.records[0], sink.last()
	if first.State != DeployRunning || first.ID != "deploy-1" || !strings.HasPrefix(first.Source, "build of ") || len(first.Targets) != 2 {
		t.Fatalf("first = %+v", first)
	}
	if first.Targets[0].EnvironmentID != "env-mac" || first.Targets[0].Label != "The Mac" || first.Targets[0].Platform != "darwin/arm64" {
		t.Errorf("target = %+v", first.Targets[0])
	}
	if last.State != DeployFailed || last.EndedAt == 0 {
		t.Errorf("a deploy with a failed host ends failed: %+v", last)
	}
	if mac := last.Targets[0]; mac.Stage != StageDone || mac.Error != "" {
		t.Errorf("mac = %+v", mac)
	}
	if win := last.Targets[1]; win.Stage != StageFailed || !strings.Contains(win.Error, "nothing can build") {
		t.Errorf("win = %+v", win)
	}
	if len(seen) == 0 || d.Progress == nil || d.RunID != "" {
		t.Errorf("the deployer's own progress still hears every step, and is put back: %d steps", len(seen))
	}
}

func TestDeployTracker_FinishSaysWhyAnUnreachedHostFailed(t *testing.T) {
	p := &Prepared{Request: Request{Source: SourceRelease}, Latest: Latest{Server: "1.2.3"}, Targets: []Target{{Host: Host{Name: "a"}}, {Host: Host{Name: "b"}}}}
	sink := &recordSink{}
	tracker := NewDeployTracker("d", p, sink.post)
	tracker.Event(Event{Host: "a", Stage: StageDone, Detail: "1.2.3"})
	tracker.Finish(nil, true, errors.New("context canceled"))
	last := sink.last()
	if last.Source != "release 1.2.3" || last.State != DeployCancelled {
		t.Errorf("record = %+v", last)
	}
	if a, b := last.Targets[0], last.Targets[1]; a.Stage != StageDone || a.Detail != "1.2.3" || b.Stage != StageFailed || b.Error != "context canceled" {
		t.Errorf("targets = %+v", last.Targets)
	}
}

type fakeLocalServer struct {
	mu      sync.Mutex
	records []DeployRecord
	fail    error
	slow    chan struct{}
	closed  bool
}

func (s *fakeLocalServer) Action(_ context.Context, action string, args ...any) error {
	if s.slow != nil {
		<-s.slow
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if action != deployReportAction {
		return errors.New("unexpected action " + action)
	}
	if s.fail != nil {
		return s.fail
	}
	s.records = append(s.records, *args[0].(*DeployRecord))
	return nil
}

func (s *fakeLocalServer) Close() { s.closed = true }

// The reporter never holds the deploy up: while one post is in flight, newer
// records replace the one waiting, and Close sends the last.
func TestDeployReporter_SendsTheNewestRecordAndTheLast(t *testing.T) {
	server := &fakeLocalServer{slow: make(chan struct{})}
	r := newDeployReporter(server)
	r.Post(DeployRecord{ID: "d", UpdatedAt: 1})
	time.Sleep(20 * time.Millisecond) // the first post is now in flight
	for at := int64(2); at <= 5; at++ {
		r.Post(DeployRecord{ID: "d", UpdatedAt: at})
	}
	close(server.slow)
	r.Close()
	if n := len(server.records); n < 2 || n > 3 || server.records[0].UpdatedAt != 1 || server.records[n-1].UpdatedAt != 5 || !server.closed {
		t.Fatalf("records = %+v, closed = %v", server.records, server.closed)
	}
}

// A machine with no server to tell is not an error for the deploy.
func TestDeployReporter_AServerThatDoesNotAnswerIsNotAnError(t *testing.T) {
	r := newDeployReporter(&fakeLocalServer{fail: errors.New("connection refused")})
	r.Post(DeployRecord{ID: "d"})
	r.Close()
}

// A paired host installed over SSH is told first, so its own server can say
// so to its Fleet Hubs. A host with no pairing, and one that installs on
// itself, is not.
func TestDeploy_TellsAPairedHostBeforeAnSSHInstall(t *testing.T) {
	hosts := []Host{
		{Name: "paired", SSH: "paired.example.org", Kind: KindServer, Entry: pairedEntry},
		{Name: "plain", SSH: "plain.example.org", Kind: KindServer},
	}
	cfg := Config{Checkout: fakeCheckout(t), Hosts: hosts}
	_, d := newDeployFixture(t, cfg)
	host := &fakeSelfHost{version: "0.2.0"}
	var opened []string
	d.OpenLink = func(ctx context.Context, h Host) (HostLink, error) {
		opened = append(opened, h.Name)
		return host.open(ctx, h)
	}
	p, err := d.Prepare(context.Background(), Request{Hosts: hosts, Source: SourceDev, Checkout: cfg.Checkout, ForceSSH: true})
	if err != nil {
		t.Fatal(err)
	}
	results, err := d.RunTracked(context.Background(), p, "deploy-7", func(DeployRecord) {})
	if err != nil || !results[0].OK || !results[1].OK {
		t.Fatalf("results = %+v, err = %v", results, err)
	}
	if strings.Join(host.actions, ",") != hostInstallNoticeAction || strings.Join(opened, ",") != "paired" {
		t.Errorf("actions = %v, opened = %v", host.actions, opened)
	}
}

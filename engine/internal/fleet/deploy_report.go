package fleet

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/studioclient"
	"github.com/dsswift/ion/engine/internal/utils"
)

// deployReportAction is the server action that takes a deploy's record.
const deployReportAction = "fleet.deploy.report"

// deployReportTimeout bounds one post, the dial included.
const deployReportTimeout = 10 * time.Second

// deployBeatEvery is how often a running deploy posts its record with
// nothing new in it. A record that stops arriving is a deploy that died.
var deployBeatEvery = 30 * time.Second

// LocalAction runs one action on this machine's server.
type LocalAction interface {
	Action(ctx context.Context, action string, args ...any) error
	Close()
}

// localServer is a Studio connection to this machine's server, redialed when
// it drops: the server may be restarted under a deploy that runs for an hour.
type localServer struct {
	dataDir string
	session *studioclient.Session
}

func (l *localServer) Action(ctx context.Context, action string, args ...any) error {
	var err error
	for attempt := 0; attempt < 2; attempt++ {
		if l.session == nil {
			if l.session, err = studioclient.ConnectLocal(ctx, l.dataDir); err != nil {
				return err
			}
		}
		if _, err = l.session.Action(ctx, action, args...); err == nil {
			return nil
		}
		l.Close()
	}
	return err
}

func (l *localServer) Close() {
	if l.session != nil {
		l.session.Close()
		l.session = nil
	}
}

// DeployReporter tells this machine's server about a deploy as it runs. Posts
// never hold the deploy up: they are sent by one goroutine, and a record that
// arrives while another is being sent replaces any still waiting. A machine
// with no server running is not an error; the deploy runs unreported.
type DeployReporter struct {
	server  LocalAction
	mu      sync.Mutex
	pending *DeployRecord
	wake    chan struct{}
	done    chan struct{}
	stopped chan struct{}
	stop    sync.Once
}

// NewDeployReporter reports to the server whose data directory is this
// process's (utils.IonDir).
func NewDeployReporter() *DeployReporter {
	return newDeployReporter(&localServer{dataDir: utils.IonDir()})
}

func newDeployReporter(server LocalAction) *DeployReporter {
	r := &DeployReporter{server: server, wake: make(chan struct{}, 1), done: make(chan struct{}), stopped: make(chan struct{})}
	go r.run()
	return r
}

// Post queues the record for the server.
func (r *DeployReporter) Post(record DeployRecord) {
	r.mu.Lock()
	r.pending = &record
	r.mu.Unlock()
	select {
	case r.wake <- struct{}{}:
	default:
	}
}

// Close sends the last record waiting and ends the reporter.
func (r *DeployReporter) Close() {
	r.stop.Do(func() { close(r.done) })
	<-r.stopped
}

func (r *DeployReporter) run() {
	defer close(r.stopped)
	defer r.server.Close()
	for {
		select {
		case <-r.wake:
			r.send()
		case <-r.done:
			r.send()
			return
		}
	}
}

func (r *DeployReporter) send() {
	r.mu.Lock()
	record := r.pending
	r.pending = nil
	r.mu.Unlock()
	if record == nil {
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), deployReportTimeout)
	defer cancel()
	err := r.server.Action(ctx, deployReportAction, record)
	fields := map[string]any{"deploy_id": record.ID, "state": record.State, "ok": err == nil}
	if err != nil {
		fields["error"] = err.Error()
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy record reported to this machine's server", fields)
}

// Follow keeps the tracker's record arriving while the deploy runs, and
// returns the function that stops it.
func (t *DeployTracker) Follow() (stop func()) {
	done := make(chan struct{})
	var once sync.Once
	go func() {
		tick := time.NewTicker(deployBeatEvery)
		defer tick.Stop()
		for {
			select {
			case <-done:
				return
			case <-tick.C:
				t.Beat()
			}
		}
	}()
	return func() { once.Do(func() { close(done) }) }
}

// NewDeployID names a deploy.
func NewDeployID() string {
	id := make([]byte, 8)
	rand.Read(id) //nolint:errcheck // crypto/rand.Read does not fail
	return hex.EncodeToString(id)
}

// RunTracked runs the deploy named id and hands post its record as it
// changes: at the start, on every step, every deployBeatEvery, and at the end.
func (d *Deployer) RunTracked(ctx context.Context, p *Prepared, id string, post func(DeployRecord)) ([]Result, error) {
	tracker := NewDeployTracker(id, p, post)
	progress, runID := d.Progress, d.RunID
	d.RunID = id
	d.Progress = func(e Event) {
		tracker.Event(e)
		if progress != nil {
			progress(e)
		}
	}
	defer func() { d.Progress, d.RunID = progress, runID }()
	tracker.Start()
	stop := tracker.Follow()
	results, err := d.Run(ctx, p)
	stop()
	tracker.Finish(results, ctx.Err() != nil, err)
	return results, err
}

// hostInstallNoticeAction tells a host's server that an install is about to
// replace it from outside. The server passes that on to its Fleet Hubs, and
// says so again when it is back.
const hostInstallNoticeAction = "environment.server.installNotice"

// installNoticeTimeout bounds the notice, the dial included: a host whose
// Ion is down has no server to tell, and its install does not wait on that.
var installNoticeTimeout = 12 * time.Second

// noticeInstall tells a paired host that the fleet is about to install on it
// over SSH. A host that installs on itself already knows.
func (d *Deployer) noticeInstall(ctx context.Context, t Target) {
	h := t.Host
	if d.OpenLink == nil || !h.Paired() {
		utils.LogWithFields(utils.LevelDebug, logTag, "install notice skipped: no studio connection to the host", map[string]any{"fleet_host": h.Name})
		return
	}
	ctx, cancel := context.WithTimeout(ctx, installNoticeTimeout)
	defer cancel()
	link, err := d.OpenLink(ctx, h)
	if err != nil {
		utils.LogWithFields(utils.LevelInfo, logTag, "install notice not sent: the host does not answer", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		return
	}
	defer link.Close()
	_, err = link.Action(ctx, hostInstallNoticeAction, map[string]any{"deployId": d.RunID})
	fields := map[string]any{"fleet_host": h.Name, "deploy_id": d.RunID, "ok": err == nil}
	if err != nil {
		fields["error"] = err.Error()
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "install notice sent to the host", fields)
}

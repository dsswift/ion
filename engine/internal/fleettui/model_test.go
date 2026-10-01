package fleettui

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"sync"
	"testing"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

type recorder struct {
	mu        sync.Mutex
	restarted []string
	relays    []string
	prepared  []string
	known     [][]fleet.HostStatus
	ran       []*fleet.Prepared
	reads     []string
	latests   int
	sent      []tea.Msg
}

func testDeps(r *recorder, hosts ...fleet.Host) Deps {
	return Deps{
		Config: fleet.Config{Hosts: hosts, Profiles: map[string]fleet.Profile{"home": {Relay: "wss://relay.example.org", RelayOIDC: true}}},
		Read: func(_ context.Context, h fleet.Host) fleet.HostStatus {
			r.mu.Lock()
			r.reads = append(r.reads, h.Name)
			r.mu.Unlock()
			return statusesFor([]fleet.Host{h})[0]
		},
		Latest: func(context.Context) (fleet.Latest, error) {
			r.mu.Lock()
			r.latests++
			r.mu.Unlock()
			return fleet.Latest{Desktop: "1.100.1"}, nil
		},
		Prepare: func(_ context.Context, hosts []fleet.Host, source string, known []fleet.HostStatus) (*fleet.Prepared, error) {
			r.mu.Lock()
			r.prepared = append(r.prepared, source)
			r.known = append(r.known, known)
			r.mu.Unlock()
			req := fleet.Request{Hosts: hosts, Source: source}
			return &fleet.Prepared{Request: req, Targets: []fleet.Target{{Host: hosts[0], Component: hosts[0].Kind}}}, nil
		},
		DefaultSource: fleet.SourceDev,
		Run: func(_ context.Context, p *fleet.Prepared, progress func(fleet.Event)) ([]fleet.Result, error) {
			r.mu.Lock()
			r.ran = append(r.ran, p)
			r.mu.Unlock()
			progress(fleet.Event{Host: p.Targets[0].Host.Name, Stage: fleet.StageDeploying})
			return []fleet.Result{{Host: p.Targets[0].Host.Name, OK: true, LogPath: "/tmp/x.log"}}, nil
		},
		Restart: func(_ context.Context, h fleet.Host) error {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.restarted = append(r.restarted, h.Name)
			return nil
		},
		SetRelay: func(_ context.Context, h fleet.Host, p fleet.Profile) error {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.relays = append(r.relays, h.Name+" "+p.Relay)
			return nil
		},
		Send: func(msg tea.Msg) {
			r.mu.Lock()
			defer r.mu.Unlock()
			r.sent = append(r.sent, msg)
		},
	}
}

func statusesFor(hosts []fleet.Host, transfers ...string) []fleet.HostStatus {
	var out []fleet.HostStatus
	for i, h := range hosts {
		v := "3"
		if i < len(transfers) {
			v = transfers[i]
		}
		r := &studiostatus.Report{SchemaVersion: 1, Kind: h.Kind, Formats: studiostatus.MergeFormats(nil, []compat.Format{{ID: "transfer-archive", Owner: "server", Version: v, Rule: compat.RuleExact, Meaning: "moves conversations"}})}
		if h.Kind == fleet.KindDesktop {
			r.Components.Desktop = &studiostatus.DesktopApp{Version: "1.101.0"}
		}
		out = append(out, fleet.HostStatus{Host: h, Via: fleet.ViaSSH, Report: r})
	}
	return out
}

var (
	devbox = fleet.Host{Name: "devbox", SSH: "devbox", Kind: fleet.KindServer, Profile: "home"}
	mac    = fleet.Host{Name: "mac", SSH: "mac", Kind: fleet.KindDesktop}
)

// press sends one key through the model.
func press(t *testing.T, m Model, k string) (Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.key(k)
	return next.(Model), cmd
}

func update(t *testing.T, m Model, msg tea.Msg) (Model, tea.Cmd) {
	t.Helper()
	next, cmd := m.Update(msg)
	return next.(Model), cmd
}

// runCmd runs a command and every message a batch yields.
func runCmd(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	msg := cmd()
	if batch, ok := msg.(tea.BatchMsg); ok {
		var out []tea.Msg
		for _, c := range batch {
			out = append(out, runCmd(c)...)
		}
		return out
	}
	return []tea.Msg{msg}
}

// answered hands the model each status as a finished read.
func answered(t *testing.T, m Model, statuses []fleet.HostStatus) Model {
	t.Helper()
	for _, st := range statuses {
		m, _ = update(t, m, hostStatusMsg(st))
	}
	return m
}

func loaded(t *testing.T, r *recorder) Model {
	m := New(testDeps(r, devbox, mac))
	return answered(t, m, statusesFor([]fleet.Host{devbox, mac}, "3", "2"))
}

// clock is a test's hand-moved time.
type clock struct{ t time.Time }

func (c *clock) now() time.Time { return c.t }

// readsStarted runs a command's reads and returns the hosts read, and the
// messages the reads produced. A tick in the command is left to run out on
// its own.
func readsStarted(t *testing.T, r *recorder, cmd tea.Cmd) ([]string, []tea.Msg) {
	t.Helper()
	r.mu.Lock()
	before := len(r.reads)
	r.mu.Unlock()
	msgs := runQuick(cmd)
	r.mu.Lock()
	defer r.mu.Unlock()
	return append([]string(nil), r.reads[before:]...), msgs
}

// runQuick runs a command and every command a batch holds, giving up on one
// that does not answer at once (a tick).
func runQuick(cmd tea.Cmd) []tea.Msg {
	if cmd == nil {
		return nil
	}
	done := make(chan tea.Msg, 1)
	go func() { done <- cmd() }()
	select {
	case msg := <-done:
		if batch, ok := msg.(tea.BatchMsg); ok {
			var out []tea.Msg
			for _, c := range batch {
				out = append(out, runQuick(c)...)
			}
			return out
		}
		return []tea.Msg{msg}
	case <-time.After(100 * time.Millisecond):
		return nil
	}
}

func TestSelectionAndTargets(t *testing.T) {
	m := loaded(t, &recorder{})
	if got := m.targets(); len(got) != 1 || got[0].Name != "devbox" {
		t.Fatalf("no selection targets the cursor host: %v", got)
	}
	m, _ = press(t, m, "down")
	m, _ = press(t, m, "space")
	if got := m.targets(); len(got) != 1 || got[0].Name != "mac" {
		t.Fatalf("selection = %v", got)
	}
	m, _ = press(t, m, "a")
	if len(m.targets()) != 2 {
		t.Fatalf("a selects all: %v", m.targets())
	}
	m, _ = press(t, m, "a")
	if len(m.selected) != 0 {
		t.Fatalf("a again clears: %v", m.selected)
	}
}

func TestRestartAsksThenRuns(t *testing.T) {
	r := &recorder{}
	m := loaded(t, r)
	m, _ = press(t, m, "R")
	if m.screen != screenConfirm || !strings.Contains(m.View().Content, "restart on devbox?") {
		t.Fatalf("R must ask first: screen=%v", m.screen)
	}
	m, cmd := press(t, m, "n")
	if m.screen != screenTable || cmd != nil || len(r.restarted) != 0 {
		t.Fatal("any key but y cancels")
	}
	m, _ = press(t, m, "R")
	m, cmd = press(t, m, "y")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if len(r.restarted) != 1 || r.restarted[0] != "devbox" || !strings.Contains(m.notice, "restart on devbox done") {
		t.Fatalf("restarted=%v notice=%q", r.restarted, m.notice)
	}
	m, _ = press(t, m, "L")
	_, cmd = press(t, m, "y")
	runCmd(cmd)
	if len(r.relays) != 1 || r.relays[0] != "devbox wss://relay.example.org" {
		t.Fatalf("relays = %v", r.relays)
	}
}

func TestTableShowsDriftAndCompatMatrix(t *testing.T) {
	m := loaded(t, &recorder{})
	view := m.View().Content
	if !strings.Contains(view, "3 ≠") && !strings.Contains(view, "2 ≠") {
		t.Errorf("the host whose transfer format differs must be marked:\n%s", view)
	}
	m, _ = press(t, m, "c")
	view = m.View().Content
	if m.screen != screenCompat || !strings.Contains(view, "server/transfer-archive") || !strings.Contains(view, "can't send") || !strings.Contains(view, "can send") {
		t.Fatalf("compat view:\n%s", view)
	}
	m, _ = press(t, m, "right")
	if m.compatIndex != 0 {
		t.Errorf("one format wraps to itself, index = %d", m.compatIndex)
	}
	m, _ = press(t, m, "esc")
	if m.screen != screenTable {
		t.Error("esc returns to the table")
	}
}

func TestDeployFlow(t *testing.T) {
	r := &recorder{}
	m := loaded(t, r)
	m, cmd := press(t, m, "d")
	if m.screen != screenDeploy || !m.preparing {
		t.Fatalf("d opens the deploy screen and prepares: %v %v", m.screen, m.preparing)
	}
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if m.prepared == nil || r.prepared[0] != fleet.SourceDev {
		t.Fatalf("prepared = %+v", r.prepared)
	}
	m, _ = press(t, m, "e")
	if !m.editingSource || m.sourceInput != fleet.SourceDev {
		t.Fatalf("e edits the source, starting from the current one: %v %q", m.editingSource, m.sourceInput)
	}
	m, _ = press(t, m, "ctrl+u")
	m = typeText(t, m, "release")
	m, cmd = press(t, m, "enter")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if m.source != fleet.SourceRelease || r.prepared[1] != fleet.SourceRelease || m.editingSource {
		t.Fatalf("a typed source prepares again: %v", r.prepared)
	}
	m.prepared.Preflight.Downgrades = []fleet.Downgrade{{Host: "devbox"}}
	m, cmd = press(t, m, "y")
	if cmd != nil || m.deploying || !strings.Contains(m.notice, "press D") {
		t.Fatalf("a downgrade needs D first: deploying=%v notice=%q", m.deploying, m.notice)
	}
	m, _ = press(t, m, "D")
	m, cmd = press(t, m, "y")
	if !m.deploying || cmd == nil || !m.prepared.Request.AllowDowngrade {
		t.Fatal("y after D deploys with the downgrade allowed")
	}
	if next, _ := press(t, m, "esc"); next.screen != screenDeploy {
		t.Fatal("a deploy in flight keeps its screen")
	}
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if len(r.sent) != 1 {
		t.Fatalf("progress travels through Send: %v", r.sent)
	}
	m, _ = update(t, m, r.sent[0])
	if m.deploying || len(m.results) != 1 || m.stages["devbox"].Stage != fleet.StageDeploying || !strings.Contains(m.notice, "deployed 1") {
		t.Fatalf("after: deploying=%v results=%v stages=%v notice=%q", m.deploying, m.results, m.stages, m.notice)
	}
}

func typeText(t *testing.T, m Model, text string) Model {
	t.Helper()
	for _, r := range text {
		m, _ = press(t, m, string(r))
	}
	return m
}

// TestDeployAsksForASourceWhenNoneIsKnown: with no default source, d opens
// the source prompt instead of failing, and a typed path is what prepares.
func TestDeployAsksForASourceWhenNoneIsKnown(t *testing.T) {
	r := &recorder{}
	deps := testDeps(r, devbox)
	deps.DefaultSource = ""
	m := New(deps)
	m = answered(t, m, statusesFor([]fleet.Host{devbox}))
	m, cmd := press(t, m, "d")
	if m.screen != screenDeploy || !m.editingSource || cmd != nil || len(r.prepared) != 0 {
		t.Fatalf("d with no source must ask for one: screen=%v editing=%v", m.screen, m.editingSource)
	}
	if !strings.Contains(m.View().Content, "Source: ▏") {
		t.Fatalf("the prompt must show:\n%s", m.View().Content)
	}
	m, _ = press(t, m, "enter")
	if m.sourceErr == "" || m.editingSource != true {
		t.Fatal("an empty source is refused in place")
	}
	m = typeText(t, m, "~/src/ionx")
	m, _ = press(t, m, "backspace")
	m, cmd = press(t, m, "enter")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if len(r.prepared) != 1 || r.prepared[0] != "~/src/ion" || m.prepared == nil {
		t.Fatalf("prepared = %v", r.prepared)
	}
}

// TestDeploySourceThatFailsIsAskedForAgain keeps the prompt open with the reason.
func TestDeploySourceThatFailsIsAskedForAgain(t *testing.T) {
	deps := testDeps(&recorder{}, devbox)
	deps.Prepare = func(context.Context, []fleet.Host, string, []fleet.HostStatus) (*fleet.Prepared, error) {
		return nil, errors.New("/tmp is not an Ion checkout (no scripts/package-studio-server.sh)")
	}
	m := New(deps)
	m = answered(t, m, statusesFor([]fleet.Host{devbox}))
	m, cmd := press(t, m, "d")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if m.screen != screenDeploy || !m.editingSource || m.sourceInput != fleet.SourceDev || !strings.Contains(m.View().Content, "not an Ion checkout") {
		t.Fatalf("screen=%v editing=%v input=%q\n%s", m.screen, m.editingSource, m.sourceInput, m.View().Content)
	}
	m, _ = press(t, m, "esc")
	if m.screen != screenTable {
		t.Fatal("esc with no plan returns to the table")
	}
}

func TestTerminalExecHandsInteractiveCommandsToTheProgram(t *testing.T) {
	var got []tea.Msg
	send := func(msg tea.Msg) {
		got = append(got, msg)
		if tm, ok := msg.(terminalMsg); ok {
			tm.done <- errors.New("sudo refused")
		}
	}
	ok := helperSpec("ok")
	ok.Interactive = true
	err := TerminalExec(send)(context.Background(), ok)
	if err == nil || err.Error() != "sudo refused" || len(got) != 1 {
		t.Fatalf("err=%v sent=%v", err, got)
	}
	if err := TerminalExec(send)(context.Background(), helperSpec("ok")); err != nil || len(got) != 1 {
		t.Fatalf("a non-interactive command runs directly: err=%v sent=%d", err, len(got))
	}
}

func TestSpecCommandShowsItsBannerBeforeTheCommand(t *testing.T) {
	var term, log bytes.Buffer
	spec := helperSpec("echo", "Password:")
	spec.Banner, spec.Stdout = "ion fleet is installing on mac.", &log
	c := &specCommand{spec: spec}
	c.SetStdout(&term)
	if err := c.Run(); err != nil {
		t.Fatal(err)
	}
	if term.String() != "\nion fleet is installing on mac.\n\nPassword:\n" || log.String() != "Password:\n" {
		t.Errorf("terminal=%q log=%q", term.String(), log.String())
	}
}

func TestKeyPressRoutes(t *testing.T) {
	m := loaded(t, &recorder{})
	_, cmd := update(t, m, tea.KeyPressMsg{Code: 'q', Text: "q"})
	if cmd == nil {
		t.Fatal("q quits from the table")
	}
	if _, ok := cmd().(tea.QuitMsg); !ok {
		t.Fatal("q must quit")
	}
}

// The table counts a host's devices with the fleet's own pairing left out;
// the detail lists them, connected first.
func TestDevicesInTableAndDetail(t *testing.T) {
	m := loaded(t, &recorder{})
	now := time.Now().UnixMilli()
	m.statuses[0].Report.Devices = []studiostatus.PairedDevice{
		{ClientID: "fleet", Label: "ion fleet on ops", Kind: "desktop", Connected: true, Self: true},
		{ClientID: "laptop", Label: "laptop", Kind: "desktop", LastSeen: now - 3*int64(time.Hour/time.Millisecond), Admin: true},
		{ClientID: "phone", Label: "iPhone", Kind: "mobile", Connected: true},
	}
	if view := m.View().Content; !strings.Contains(view, "DEVICES") || !strings.Contains(view, "2 · 1 on") {
		t.Fatalf("table:\n%s", view)
	}
	m, _ = press(t, m, "enter")
	view := m.View().Content
	if strings.Contains(view, "ion fleet on ops") {
		t.Errorf("the fleet's own pairing is not one of the host's devices:\n%s", view)
	}
	phone, laptop := strings.Index(view, "iPhone"), strings.Index(view, "laptop")
	if phone < 0 || laptop < 0 || phone > laptop || !strings.Contains(view, "3h ago") || !strings.Contains(view, "phone") {
		t.Errorf("detail must list connected devices first, with kind and last seen:\n%s", view)
	}
}

// A host deployed outside the fleet is only read: deploy, restart, and relay
// say why instead of opening a screen.
func TestExternalHost_KeysSayItIsReadOnly(t *testing.T) {
	ext := fleet.Host{Name: "atlas", URL: "https://atlas.example.org", Kind: fleet.KindServer}
	r := &recorder{}
	m := New(testDeps(r, ext))
	m = answered(t, m, statusesFor([]fleet.Host{ext}, "3"))
	for _, k := range []string{"d", "R", "L"} {
		m, _ = press(t, m, k)
		if m.screen != screenTable || !strings.Contains(m.notice, "deployed outside the fleet") {
			t.Fatalf("%s: screen %v notice %q", k, m.screen, m.notice)
		}
	}
	m, _ = press(t, m, "enter")
	if view := m.View().Content; !strings.Contains(view, "https://atlas.example.org · deployed outside the fleet, read only") || strings.Contains(view, "d deploy this host") {
		t.Errorf("detail:\n%s", view)
	}
	if len(r.prepared) != 0 || len(r.restarted) != 0 || len(r.relays) != 0 {
		t.Errorf("nothing may run: %+v", r)
	}
}

// Each host keeps its own rhythm: a host that answers is read again after
// ReadInterval, a down one only after its back-off, and neither waits on the
// other.
func TestHostsReadOnTheirOwnSchedule(t *testing.T) {
	r := &recorder{}
	c := &clock{t: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)}
	deps := testDeps(r, devbox, mac)
	deps.Now = c.now
	m := New(deps)
	if reads, _ := readsStarted(t, r, m.Init()); len(reads) != 2 {
		t.Fatalf("Init reads every host once: %v", reads)
	}
	down := fleet.HostStatus{Host: mac, Via: fleet.ViaNone, Error: "ssh: unreachable"}
	m = answered(t, m, []fleet.HostStatus{statusesFor([]fleet.Host{devbox})[0], down})

	c.t = c.t.Add(ReadInterval)
	m, cmd := update(t, m, tickMsg(c.t))
	if reads, _ := readsStarted(t, r, cmd); len(reads) != 1 || reads[0] != "devbox" {
		t.Fatalf("after %s only the live host is due: %v", ReadInterval, reads)
	}
	if view := m.View().Content; !strings.Contains(view, "down · retry 45s") {
		t.Errorf("a down host shows when it is tried again:\n%s", view)
	}
	m = answered(t, m, statusesFor([]fleet.Host{devbox}))

	c.t = c.t.Add(RetryFirst - ReadInterval)
	m, cmd = update(t, m, tickMsg(c.t))
	if reads, _ := readsStarted(t, r, cmd); len(reads) != 2 {
		t.Fatalf("after %s the down host is tried again beside the live one: %v", RetryFirst, reads)
	}
	m = answered(t, m, []fleet.HostStatus{statusesFor([]fleet.Host{devbox})[0], down})
	c.t = c.t.Add(RetryFirst)
	m, cmd = update(t, m, tickMsg(c.t))
	if reads, _ := readsStarted(t, r, cmd); strings.Contains(strings.Join(reads, ","), "mac") {
		t.Fatalf("a second failure waits twice as long: %v", reads)
	}
	if got := retryAfter(10); got != RetryMax {
		t.Errorf("the back-off stops at %s, got %s", RetryMax, got)
	}
	m, cmd = press(t, m, "r")
	if reads, _ := readsStarted(t, r, cmd); !strings.Contains(strings.Join(reads, ","), "mac") || m.sched["mac"].failures != 0 {
		t.Errorf("r reads every host now and forgets the back-off: %v %+v", reads, m.sched["mac"])
	}
}

// Nothing is read while the table is hidden; going back reads what is due.
func TestReadsPauseOffTheTable(t *testing.T) {
	r := &recorder{}
	c := &clock{t: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)}
	deps := testDeps(r, devbox, mac)
	deps.Now = c.now
	m := answered(t, New(deps), statusesFor([]fleet.Host{devbox, mac}))
	m, _ = update(t, m, latestMsg{})
	m, cmd := press(t, m, "d")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	c.t = c.t.Add(time.Hour)
	m, cmd = update(t, m, tickMsg(c.t))
	if reads, _ := readsStarted(t, r, cmd); len(reads) != 0 || r.latests != 0 {
		t.Fatalf("the deploy screen reads nothing: hosts %v, releases %d", reads, r.latests)
	}
	m, _ = press(t, m, "esc")
	_, cmd = update(t, m, tickMsg(c.t))
	if reads, _ := readsStarted(t, r, cmd); len(reads) != 2 || r.latests != 1 {
		t.Fatalf("back on the table the overdue reads start: hosts %v, releases %d", reads, r.latests)
	}
}

// The releases are looked up at open, every ReleaseInterval, and on r; not
// with every host read.
func TestReleasesAreReadRarely(t *testing.T) {
	r := &recorder{}
	c := &clock{t: time.Date(2026, 9, 27, 12, 0, 0, 0, time.UTC)}
	deps := testDeps(r, devbox)
	deps.Now = c.now
	m := New(deps)
	_, msgs := readsStarted(t, r, m.Init())
	for _, msg := range msgs {
		m, _ = update(t, m, msg)
	}
	for i := 0; i < 20; i++ {
		c.t = c.t.Add(ReadInterval)
		var cmd tea.Cmd
		m, cmd = update(t, m, tickMsg(c.t))
		_, msgs = readsStarted(t, r, cmd)
		for _, msg := range msgs {
			m, _ = update(t, m, msg)
		}
	}
	if r.latests != 1 {
		t.Fatalf("20 host reads looked up the releases %d times, want once", r.latests)
	}
	c.t = c.t.Add(ReleaseInterval)
	m, cmd := update(t, m, tickMsg(c.t))
	_, msgs = readsStarted(t, r, cmd)
	for _, msg := range msgs {
		m, _ = update(t, m, msg)
	}
	if r.latests != 2 {
		t.Fatalf("after %s the releases are looked up again: %d", ReleaseInterval, r.latests)
	}
	_, cmd = press(t, m, "r")
	readsStarted(t, r, cmd)
	if r.latests != 3 {
		t.Fatalf("r looks them up now: %d", r.latests)
	}
}

// A deploy plans from the table's reads, and its own reads of the targets
// afterwards become their rows, with no second read.
func TestDeployUsesAndFeedsTheTable(t *testing.T) {
	r := &recorder{}
	deps := testDeps(r, devbox, mac)
	deps.Run = func(_ context.Context, p *fleet.Prepared, _ func(fleet.Event)) ([]fleet.Result, error) {
		after := statusesFor([]fleet.Host{devbox}, "4")[0]
		return []fleet.Result{{Host: "devbox", OK: true, After: &after}}, nil
	}
	m := New(deps)
	m = answered(t, m, statusesFor([]fleet.Host{devbox}))
	m, cmd := press(t, m, "d")
	for _, msg := range runCmd(cmd) {
		m, _ = update(t, m, msg)
	}
	if len(r.known) != 1 || len(r.known[0]) != 1 || r.known[0][0].Host.Name != "devbox" {
		t.Fatalf("the plan gets the hosts the table has read, not the one still reading: %+v", r.known)
	}
	m, cmd = press(t, m, "y")
	for _, msg := range runCmd(cmd) {
		m, cmd = update(t, m, msg)
		if cmd != nil {
			t.Fatal("a finished deploy starts no reads")
		}
	}
	if got := fleet.FormatCell(m.statuses[0].Report, fleet.TransferFormat); got != "4" || m.sched["devbox"].next.IsZero() {
		t.Errorf("the deploy's read is devbox's row: transfer %q, schedule %+v", got, m.sched["devbox"])
	}
}

// A restart reads only the host it restarted.
func TestActionReadsOnlyItsHost(t *testing.T) {
	r := &recorder{}
	m := loaded(t, r)
	m, _ = press(t, m, "R")
	m, cmd := press(t, m, "y")
	for _, msg := range runCmd(cmd) {
		m, cmd = update(t, m, msg)
	}
	if reads, _ := readsStarted(t, r, cmd); len(reads) != 1 || reads[0] != "devbox" {
		t.Fatalf("reads after a restart of devbox: %v", reads)
	}
}

// helperSpec runs this test binary as a portable child process (no `true` or
// `echo` on Windows): "ok" exits 0, "echo" prints its arguments.
func helperSpec(mode string, args ...string) fleet.ExecSpec {
	return fleet.ExecSpec{Name: os.Args[0], Args: append([]string{"-test.run=^TestHelperProcess$", "--", mode}, args...)}
}

func TestHelperProcess(t *testing.T) {
	i := slices.Index(os.Args, "--")
	if i < 0 || i+1 >= len(os.Args) {
		return
	}
	if os.Args[i+1] == "echo" {
		fmt.Println(strings.Join(os.Args[i+2:], " "))
	}
	os.Exit(0)
}

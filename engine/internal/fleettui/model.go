// Package fleettui is the `ion fleet` dashboard: a live table of the fleet's
// hosts, a host's detail with its components and Format Versions, the
// compatibility matrices, and deploys run from a selection or one host.
//
// The dashboard owns the fleet's state: each host is read on its own
// schedule (schedule.go), and a deploy plans from what the table already
// holds. The model is plain state driven by messages, so its behaviour is
// tested without a terminal. It never animates: a read or a deploy shows its
// stage as text.
package fleettui

import (
	"context"
	"fmt"
	"sort"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
)

// Deps are everything the dashboard does outside itself.
type Deps struct {
	Config fleet.Config
	// Read reads one host.
	Read   func(ctx context.Context, h fleet.Host) fleet.HostStatus
	Latest func(ctx context.Context) (fleet.Latest, error)
	// Prepare plans a deploy of hosts from a source as typed: dev, release,
	// or a path to an Ion checkout. known are the hosts the dashboard has
	// read, so the plan reads only the rest.
	Prepare  func(ctx context.Context, hosts []fleet.Host, source string, known []fleet.HostStatus) (*fleet.Prepared, error)
	Run      func(ctx context.Context, p *fleet.Prepared, progress func(fleet.Event)) ([]fleet.Result, error)
	Restart  func(ctx context.Context, h fleet.Host) error
	SetRelay func(ctx context.Context, h fleet.Host, p fleet.Profile) error
	// Send delivers a message from a background job to the running program.
	Send func(tea.Msg)
	// Checkout is the version the fleet file's checkout would build.
	Checkout CheckoutVersions
	// DefaultSource pre-fills the deploy source; empty means the deploy
	// screen asks for one.
	DefaultSource string
	// Now is the clock; time.Now by default.
	Now func() time.Time
}

// CheckoutVersions are the versions a dev deploy would install.
type CheckoutVersions struct {
	Server  string
	Desktop string
}

type screen int

const (
	screenTable screen = iota
	screenDetail
	screenCompat
	screenDeploy
	screenConfirm
)

// Messages.
type (
	// hostStatusMsg is one host's read.
	hostStatusMsg fleet.HostStatus
	// latestMsg is the latest releases.
	latestMsg   fleet.Latest
	tickMsg     time.Time
	preparedMsg struct {
		prepared *fleet.Prepared
		err      error
	}
	eventMsg      fleet.Event
	deployDoneMsg struct {
		results []fleet.Result
		err     error
	}
	actionDoneMsg struct {
		op, host string
		err      error
	}
)

// pendingAction is a restart or relay change waiting for a yes.
type pendingAction struct {
	op    string // "restart" | "relay set"
	hosts []fleet.Host
}

// Model is the dashboard state.
type Model struct {
	deps       Deps
	statuses   []fleet.HostStatus
	latest     fleet.Latest
	cursor     int
	selected   map[string]bool
	screen   screen
	sched    map[string]hostSchedule
	releases releaseSchedule
	// lastRead is when a host last answered or failed.
	lastRead time.Time
	width    int
	notice   string

	compatIndex int

	// Deploy. source is the deploy source as typed; while editingSource the
	// deploy screen reads a new one into sourceInput.
	source         string
	sourceInput    string
	editingSource  bool
	sourceErr      string
	deployHosts    []fleet.Host
	prepared       *fleet.Prepared
	preparing      bool
	deploying      bool
	allowDowngrade bool
	stages         map[string]fleet.Event
	results        []fleet.Result

	confirm *pendingAction
}

// New builds the dashboard for the fleet file's hosts.
func New(deps Deps) Model {
	// Init starts the first reads, so every host begins in flight.
	m := Model{deps: deps, selected: map[string]bool{}, source: deps.DefaultSource, stages: map[string]fleet.Event{}, width: 120,
		sched: map[string]hostSchedule{}, releases: releaseSchedule{inFlight: true}}
	for _, h := range deps.Config.Hosts {
		m.statuses = append(m.statuses, fleet.HostStatus{Host: h, Via: viaReading})
		m.sched[h.Name] = hostSchedule{inFlight: true}
	}
	return m
}

// Init reads every host and the releases, and starts the schedule.
func (m Model) Init() tea.Cmd {
	cmds := []tea.Cmd{tick(), releasesCmd(m.deps.Latest)}
	for _, st := range m.statuses {
		cmds = append(cmds, readCmd(m.deps.Read, st.Host))
	}
	return tea.Batch(cmds...)
}

// Update handles one message.
func (m Model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.WindowSizeMsg:
		m.width = msg.Width
		return m, nil
	case hostStatusMsg:
		m.applyRead(fleet.HostStatus(msg))
		return m, nil
	case latestMsg:
		m.latest = fleet.Latest(msg)
		m.releases = releaseSchedule{next: m.now().Add(ReleaseInterval)}
		return m, nil
	case tickMsg:
		return m, tea.Batch(m.due(), tick())
	case preparedMsg:
		m.preparing = false
		if msg.err != nil {
			// A source that does not work is asked for again, with the reason.
			m.prepared, m.editingSource, m.sourceInput, m.sourceErr = nil, true, m.source, msg.err.Error()
			return m, nil
		}
		m.prepared, m.sourceErr = msg.prepared, ""
		return m, nil
	case tea.PasteMsg:
		if m.screen == screenDeploy && m.editingSource {
			m.sourceInput += strings.TrimSpace(msg.Content)
		}
		return m, nil
	case eventMsg:
		m.stages[msg.Host] = fleet.Event(msg)
		return m, nil
	case deployDoneMsg:
		m.deploying = false
		m.results = msg.results
		if msg.err != nil {
			m.notice = "deploy: " + msg.err.Error()
		} else {
			m.notice = deploySummary(msg.results)
		}
		// The deploy read its targets when it finished; those reads are the
		// hosts' newest.
		for _, r := range msg.results {
			if r.After != nil {
				m.applyRead(*r.After)
			}
		}
		return m, nil
	case actionDoneMsg:
		if msg.err != nil {
			m.notice = fmt.Sprintf("%s on %s failed: %v", msg.op, msg.host, msg.err)
		} else {
			m.notice = fmt.Sprintf("%s on %s done", msg.op, msg.host)
		}
		// Only the host the action touched changed.
		for _, st := range m.statuses {
			if st.Host.Name == msg.host && !m.sched[msg.host].inFlight {
				return m, m.readHost(st.Host)
			}
		}
		return m, nil
	case terminalMsg:
		return m, handTerminal(msg)
	case terminalDoneMsg:
		return m, nil
	case tea.KeyPressMsg:
		return m.key(msg.String())
	}
	return m, nil
}

func (m Model) key(k string) (tea.Model, tea.Cmd) {
	if k == "ctrl+c" {
		return m, tea.Quit
	}
	switch m.screen {
	case screenTable:
		return m.tableKey(k)
	case screenDetail:
		return m.detailKey(k)
	case screenCompat:
		return m.compatKey(k)
	case screenDeploy:
		return m.deployKey(k)
	case screenConfirm:
		return m.confirmKey(k)
	}
	return m, nil
}

func (m Model) tableKey(k string) (tea.Model, tea.Cmd) {
	switch k {
	case "q":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.statuses)-1 {
			m.cursor++
		}
	case "space", " ":
		if h, ok := m.current(); ok {
			m.selected[h.Name] = !m.selected[h.Name]
		}
	case "a":
		all := len(m.selected) < len(m.statuses) || anyFalse(m.selected)
		m.selected = map[string]bool{}
		if all {
			for _, st := range m.statuses {
				m.selected[st.Host.Name] = true
			}
		}
	case "enter":
		if len(m.statuses) > 0 {
			m.screen = screenDetail
		}
	case "c":
		m.screen, m.compatIndex = screenCompat, 0
	case "r":
		m.notice = ""
		return m, m.readNow()
	case "d":
		return m.startDeploy(m.targets())
	case "R":
		return m.ask("restart", m.targets())
	case "L":
		return m.ask("relay set", m.targets())
	}
	return m, nil
}

func (m Model) detailKey(k string) (tea.Model, tea.Cmd) {
	h, ok := m.current()
	switch {
	case k == "esc" || k == "q":
		m.screen = screenTable
	case !ok:
	case k == "d":
		return m.startDeploy([]fleet.Host{h})
	case k == "R":
		return m.ask("restart", []fleet.Host{h})
	case k == "L":
		return m.ask("relay set", []fleet.Host{h})
	}
	return m, nil
}

func (m Model) compatKey(k string) (tea.Model, tea.Cmd) {
	n := len(fleet.Comparable(m.statuses))
	switch k {
	case "esc", "q":
		m.screen = screenTable
	case "right", "l", "tab":
		if n > 0 {
			m.compatIndex = (m.compatIndex + 1) % n
		}
	case "left", "h", "shift+tab":
		if n > 0 {
			m.compatIndex = (m.compatIndex - 1 + n) % n
		}
	}
	return m, nil
}

// targets is the selection, or the host under the cursor when none is selected.
func (m Model) targets() []fleet.Host {
	var out []fleet.Host
	for _, st := range m.statuses {
		if m.selected[st.Host.Name] {
			out = append(out, st.Host)
		}
	}
	if len(out) == 0 {
		if h, ok := m.current(); ok {
			out = append(out, h)
		}
	}
	return out
}

func (m Model) current() (fleet.Host, bool) {
	if m.cursor < 0 || m.cursor >= len(m.statuses) {
		return fleet.Host{}, false
	}
	return m.statuses[m.cursor].Host, true
}

func anyFalse(sel map[string]bool) bool {
	for _, v := range sel {
		if !v {
			return true
		}
	}
	return false
}

func deploySummary(results []fleet.Result) string {
	var ok, failed []string
	for _, r := range results {
		if r.OK {
			ok = append(ok, r.Host)
		} else {
			failed = append(failed, r.Host)
		}
	}
	sort.Strings(ok)
	sort.Strings(failed)
	if len(failed) == 0 {
		return fmt.Sprintf("deployed %d host(s)", len(ok))
	}
	return fmt.Sprintf("deployed %d, failed %d: %v (logs in ~/.ion/fleet/logs)", len(ok), len(failed), failed)
}

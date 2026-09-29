package fleettui

import (
	"context"
	"fmt"
	"time"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Each host is read on its own schedule, and only while the table or a host's
// detail is on screen: a slow or dead host never holds back another, and
// nothing is read that nobody can see.
const (
	// ReadInterval is how long after a host answers it is read again.
	ReadInterval = 15 * time.Second
	// RetryFirst is how long after a failed read a host is tried again; each
	// further failure doubles it, up to RetryMax.
	RetryFirst = time.Minute
	RetryMax   = 5 * time.Minute
	// ReleaseInterval is how often the latest releases are looked up.
	// GitHub allows 60 unauthenticated calls an hour.
	ReleaseInterval = 30 * time.Minute
	// scheduleTick is how often the dashboard checks what is due.
	scheduleTick = time.Second
)

// viaReading marks a host that has not answered its first read yet.
const viaReading = "reading"

// hostSchedule is when a host is read next.
type hostSchedule struct {
	inFlight bool
	next     time.Time
	// failures counts reads that failed in a row.
	failures int
}

// releaseSchedule is when the latest releases are looked up next.
type releaseSchedule struct {
	inFlight bool
	next     time.Time
}

func tick() tea.Cmd {
	return tea.Tick(scheduleTick, func(t time.Time) tea.Msg { return tickMsg(t) })
}

func (m Model) now() time.Time {
	if m.deps.Now != nil {
		return m.deps.Now()
	}
	return time.Now()
}

// reading reports whether reads may start: only while the table or a host's
// detail shows, and never while a deploy is prepared or runs.
func (m Model) reading() bool {
	return (m.screen == screenTable || m.screen == screenDetail) && !m.preparing && !m.deploying
}

// retryAfter is the wait after the nth failed read in a row.
func retryAfter(failures int) time.Duration {
	d := RetryFirst
	for i := 1; i < failures && d < RetryMax; i++ {
		d *= 2
	}
	return min(d, RetryMax)
}

// due starts the reads whose time has come.
func (m *Model) due() tea.Cmd {
	if !m.reading() {
		return nil
	}
	now := m.now()
	var cmds []tea.Cmd
	for _, st := range m.statuses {
		s := m.sched[st.Host.Name]
		if !s.inFlight && !now.Before(s.next) {
			cmds = append(cmds, m.readHost(st.Host))
		}
	}
	if !m.releases.inFlight && !now.Before(m.releases.next) {
		cmds = append(cmds, m.readReleases())
	}
	return tea.Batch(cmds...)
}

// readNow reads every host and the releases now, forgetting every back-off.
func (m *Model) readNow() tea.Cmd {
	var cmds []tea.Cmd
	for _, st := range m.statuses {
		s := m.sched[st.Host.Name]
		s.failures = 0
		m.sched[st.Host.Name] = s
		if !s.inFlight {
			cmds = append(cmds, m.readHost(st.Host))
		}
	}
	if !m.releases.inFlight {
		cmds = append(cmds, m.readReleases())
	}
	return tea.Batch(cmds...)
}

// readHost marks the host in flight and reads it.
func (m *Model) readHost(h fleet.Host) tea.Cmd {
	s := m.sched[h.Name]
	s.inFlight = true
	m.sched[h.Name] = s
	return readCmd(m.deps.Read, h)
}

func (m *Model) readReleases() tea.Cmd {
	m.releases.inFlight = true
	return releasesCmd(m.deps.Latest)
}

func readCmd(read func(context.Context, fleet.Host) fleet.HostStatus, h fleet.Host) tea.Cmd {
	return func() tea.Msg { return hostStatusMsg(read(context.Background(), h)) }
}

func releasesCmd(latest func(context.Context) (fleet.Latest, error)) tea.Cmd {
	return func() tea.Msg {
		l, err := latest(context.Background())
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "fleet", "dashboard: latest release lookup failed", map[string]any{"error": err.Error()})
		}
		return latestMsg(l)
	}
}

// applyRead puts a host's read in its row and schedules its next read: soon
// after an answer, later and later after each failure.
func (m *Model) applyRead(st fleet.HostStatus) {
	found := false
	for i := range m.statuses {
		if m.statuses[i].Host.Name == st.Host.Name {
			m.statuses[i], found = st, true
		}
	}
	if !found {
		return
	}
	now := m.now()
	s := m.sched[st.Host.Name]
	s.inFlight = false
	if st.Via == fleet.ViaNone {
		s.failures++
		s.next = now.Add(retryAfter(s.failures))
		utils.LogWithFields(utils.LevelDebug, "fleet", "dashboard: host read failed; backing off", map[string]any{"fleet_host": st.Host.Name, "failures": s.failures, "retry_in": retryAfter(s.failures).String()})
	} else {
		s.failures = 0
		s.next = now.Add(ReadInterval)
	}
	m.sched[st.Host.Name] = s
	m.lastRead = now
}

// known are the hosts' finished reads, for a deploy's plan.
func (m Model) known() []fleet.HostStatus {
	var out []fleet.HostStatus
	for _, st := range m.statuses {
		if st.Via != viaReading {
			out = append(out, st)
		}
	}
	return out
}

// inFlight counts the reads under way.
func (m Model) inFlight() int {
	n := 0
	for _, s := range m.sched {
		if s.inFlight {
			n++
		}
	}
	return n
}

// reachCell is a host's REACH column: how it answered, or when a down host
// is tried again.
func (m Model) reachCell(st fleet.HostStatus) string {
	if st.Via != fleet.ViaNone {
		return st.Via
	}
	s := m.sched[st.Host.Name]
	wait := s.next.Sub(m.now())
	switch {
	case s.inFlight || wait <= 0:
		return styleBad.Render("down · retrying")
	case wait >= time.Minute:
		return styleBad.Render(fmt.Sprintf("down · retry %dm", int(wait.Round(time.Minute)/time.Minute)))
	default:
		return styleBad.Render(fmt.Sprintf("down · retry %ds", int(wait.Round(time.Second)/time.Second)))
	}
}

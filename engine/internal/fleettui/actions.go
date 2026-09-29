package fleettui

import (
	"context"
	"strings"

	tea "charm.land/bubbletea/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
)

// startDeploy opens the deploy screen. With a source it prepares the plan
// (targets, their platforms, the new build's formats, and what they change
// across the fleet); without one it asks for the source first.
func (m Model) startDeploy(hosts []fleet.Host) (tea.Model, tea.Cmd) {
	if len(hosts) == 0 || m.deploying {
		return m, nil
	}
	if err := refuseExternal(hosts); err != nil {
		m.notice = err.Error()
		return m, nil
	}
	m.screen, m.prepared, m.results, m.allowDowngrade = screenDeploy, nil, nil, false
	m.stages, m.deployHosts, m.sourceErr = map[string]fleet.Event{}, hosts, ""
	if m.source == "" {
		m.editingSource, m.sourceInput = true, ""
		return m, nil
	}
	return m, m.prepare()
}

func (m *Model) prepare() tea.Cmd {
	m.preparing = true
	hosts, source, prepare, known := m.deployHosts, m.source, m.deps.Prepare, m.known()
	return func() tea.Msg {
		p, err := prepare(context.Background(), hosts, source, known)
		return preparedMsg{prepared: p, err: err}
	}
}

// sourceKey edits the typed source: enter uses it, esc keeps the old one.
func (m Model) sourceKey(k string) (tea.Model, tea.Cmd) {
	switch k {
	case "enter":
		typed := strings.TrimSpace(m.sourceInput)
		if typed == "" {
			m.sourceErr = "type dev, release, or a path to an Ion checkout"
			return m, nil
		}
		m.source, m.editingSource, m.sourceErr = typed, false, ""
		return m, m.prepare()
	case "esc":
		m.editingSource = false
		if m.prepared == nil {
			m.screen = screenTable
		}
	case "backspace":
		if r := []rune(m.sourceInput); len(r) > 0 {
			m.sourceInput = string(r[:len(r)-1])
		}
	case "ctrl+u":
		m.sourceInput = ""
	case "space":
		m.sourceInput += " "
	default:
		if r := []rune(k); len(r) == 1 {
			m.sourceInput += k
		}
	}
	return m, nil
}

func (m Model) deployKey(k string) (tea.Model, tea.Cmd) {
	if m.deploying {
		// A deploy in flight cannot be abandoned from here; the screen stays.
		return m, nil
	}
	if m.editingSource {
		return m.sourceKey(k)
	}
	switch k {
	case "esc", "q":
		m.screen, m.prepared = screenTable, nil
		return m, nil
	case "e":
		if m.preparing {
			return m, nil
		}
		m.editingSource, m.sourceInput = true, m.source
		return m, nil
	case "D":
		m.allowDowngrade = !m.allowDowngrade
		return m, nil
	case "y":
		if m.prepared == nil || m.preparing {
			return m, nil
		}
		if m.prepared.Preflight.Blocks() && !m.allowDowngrade {
			m.notice = "this deploy lowers a stored-data format; press D to allow it, then y"
			return m, nil
		}
		m.prepared.Request.AllowDowngrade = m.allowDowngrade
		m.deploying, m.notice = true, ""
		return m, m.run(m.prepared)
	}
	return m, nil
}

// run deploys in the background; progress arrives as eventMsg through Send.
func (m Model) run(p *fleet.Prepared) tea.Cmd {
	deps := m.deps
	return func() tea.Msg {
		results, err := deps.Run(context.Background(), p, func(e fleet.Event) {
			if deps.Send != nil {
				deps.Send(eventMsg(e))
			}
		})
		return deployDoneMsg{results: results, err: err}
	}
}

// ask shows a yes/no for a disruptive action on the hosts.
func (m Model) ask(op string, hosts []fleet.Host) (tea.Model, tea.Cmd) {
	if len(hosts) == 0 {
		return m, nil
	}
	if err := refuseExternal(hosts); err != nil {
		m.notice = err.Error()
		return m, nil
	}
	m.confirm = &pendingAction{op: op, hosts: hosts}
	m.screen = screenConfirm
	return m, nil
}

func (m Model) confirmKey(k string) (tea.Model, tea.Cmd) {
	action := m.confirm
	m.confirm, m.screen = nil, screenTable
	if k != "y" || action == nil {
		m.notice = "cancelled"
		return m, nil
	}
	var cmds []tea.Cmd
	for _, h := range action.hosts {
		cmds = append(cmds, m.action(action.op, h))
	}
	m.notice = action.op + " running on " + hostNames(action.hosts)
	return m, tea.Batch(cmds...)
}

func (m Model) action(op string, h fleet.Host) tea.Cmd {
	deps := m.deps
	return func() tea.Msg {
		ctx := context.Background()
		var err error
		if op == "restart" {
			err = deps.Restart(ctx, h)
		} else {
			err = deps.SetRelay(ctx, h, deps.Config.ProfileOf(h))
		}
		return actionDoneMsg{op: op, host: h.Name, err: err}
	}
}

func hostNames(hosts []fleet.Host) string {
	names := make([]string, 0, len(hosts))
	for _, h := range hosts {
		names = append(names, h.Name)
	}
	return strings.Join(names, ", ")
}

// refuseExternal: the fleet changes nothing on a host deployed outside it.
func refuseExternal(hosts []fleet.Host) error {
	for _, h := range hosts {
		if h.External() {
			return h.ErrExternal()
		}
	}
	return nil
}

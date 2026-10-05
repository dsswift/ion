package fleettui

import (
	"fmt"
	"strings"
	"time"

	tea "charm.land/bubbletea/v2"
	"charm.land/lipgloss/v2"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

var (
	styleTitle  = lipgloss.NewStyle().Bold(true)
	styleDim    = lipgloss.NewStyle().Foreground(lipgloss.Color("8"))
	styleWarn   = lipgloss.NewStyle().Foreground(lipgloss.Color("3"))
	styleBad    = lipgloss.NewStyle().Foreground(lipgloss.Color("1"))
	styleGood   = lipgloss.NewStyle().Foreground(lipgloss.Color("2"))
	styleCursor = lipgloss.NewStyle().Reverse(true)
)

// View renders the current screen.
func (m Model) View() tea.View {
	var body string
	switch m.screen {
	case screenDetail:
		body = m.detailView()
	case screenCompat:
		body = m.compatView()
	case screenDeploy:
		body = m.deployView()
	case screenConfirm:
		body = m.confirmView()
	default:
		body = m.tableView()
	}
	if m.notice != "" {
		body += "\n" + styleWarn.Render(m.notice) + "\n"
	}
	v := tea.NewView(body)
	v.AltScreen = true
	v.WindowTitle = "ion fleet"
	return v
}

func (m Model) header() string {
	read := "reading…"
	if !m.lastRead.IsZero() {
		read = "read " + m.lastRead.Format("15:04:05")
		if n := m.inFlight(); n > 0 {
			read += fmt.Sprintf(", reading %d", n)
		}
	}
	latest := ""
	if m.latest.Server != "" || m.latest.Desktop != "" {
		latest = fmt.Sprintf(" · latest release: server %s, desktop %s", dashIf(m.latest.Server), dashIf(m.latest.Desktop))
	}
	return styleTitle.Render(fmt.Sprintf("Ion fleet · %d hosts", len(m.statuses))) + styleDim.Render(" · "+read+latest) + "\n\n"
}

// grid pads cells into columns by display width.
func grid(rows [][]string) []string {
	widths := map[int]int{}
	for _, r := range rows {
		for i, c := range r {
			widths[i] = max(widths[i], lipgloss.Width(c))
		}
	}
	out := make([]string, len(rows))
	for ri, r := range rows {
		var b strings.Builder
		for i, c := range r {
			b.WriteString(c)
			if i < len(r)-1 {
				b.WriteString(strings.Repeat(" ", widths[i]-lipgloss.Width(c)+2))
			}
		}
		out[ri] = b.String()
	}
	return out
}

func (m Model) tableView() string {
	drift := fleet.Drift(m.statuses, fleet.TransferFormat)
	rows := [][]string{{"", "HOST", "REACH", "KIND", "DESKTOP", "SERVER", "ENGINE", "TRANSFER", "CPU", "MEMORY", "RUNNING", "DEVICES", "RELAYS"}}
	for _, st := range m.statuses {
		mark := "[ ]"
		if m.selected[st.Host.Name] {
			mark = "[x]"
		}
		r := st.Report
		reach := m.reachCell(st)
		transfer := fleet.FormatCell(r, fleet.TransferFormat)
		if drift[st.Host.Name] {
			transfer = styleWarn.Render(transfer + " ≠")
		}
		engine := fleet.EngineCell(r)
		if r != nil && r.Engine.PendingRestart {
			engine = styleWarn.Render(engine)
		}
		rows = append(rows, []string{mark, st.Host.Name, reach, fleet.KindCell(st), fleet.DesktopCell(r), fleet.ServerCell(r), engine, transfer,
			fleet.CPUCell(metrics(r)), fleet.MemCell(metrics(r)), fleet.RunningCell(r), fleet.DevicesCell(r), fleet.RelaysCell(r)})
	}
	lines := grid(rows)
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString(styleDim.Render(lines[0]) + "\n")
	for i, line := range lines[1:] {
		if i == m.cursor {
			line = styleCursor.Render(line)
		}
		b.WriteString(line + "\n")
	}
	b.WriteString("\n")
	for _, st := range m.statuses {
		if st.Error != "" {
			b.WriteString(styleBad.Render(st.Host.Name+": "+st.Error) + "\n")
		}
		for _, f := range fleet.HostFlags(st) {
			b.WriteString(styleWarn.Render(st.Host.Name+": "+f) + "\n")
		}
	}
	if accounts := accountsSection(m.statuses, m.now()); accounts != "" {
		b.WriteString("\n" + accounts)
	}
	b.WriteString("\n" + styleDim.Render("↑↓ move · space select · a all · enter host · c compatibility · d deploy · R restart · L relay · r read now · q quit"))
	return b.String()
}

func (m Model) detailView() string {
	if m.cursor >= len(m.statuses) {
		return ""
	}
	st := m.statuses[m.cursor]
	r := st.Report
	h := st.Host
	var b strings.Builder
	b.WriteString(m.header())
	target, keys := h.SSH, "d deploy this host · R restart · L relay · esc back"
	switch {
	case h.External() && h.Paired():
		// The device talks to it only over its Studio connection: the host
		// installs and restarts itself, and a relay change needs SSH.
		target, keys = dashIf(h.URL)+" · no SSH target", "d deploy this host · R restart · esc back"
	case h.External():
		target, keys = dashIf(h.URL)+" · no SSH target and no pairing, read only", "esc back"
	}
	if h.ManageOnly {
		target += " · manage-only"
	}
	b.WriteString(styleTitle.Render(h.Name) + styleDim.Render(fmt.Sprintf("  %s · %s host · profile %s · read over %s", target, fleet.KindCell(st), dashIf(h.Profile), st.Via)) + "\n\n")
	if r == nil {
		b.WriteString(styleBad.Render(dashIf(st.Error)) + "\n")
		b.WriteString("\n" + styleDim.Render("d deploy · R restart · L relay · esc back"))
		return b.String()
	}
	rows := [][]string{{"COMPONENT", "INSTALLED", "RUNNING", "LATEST RELEASE", "CHECKOUT"}}
	if c := r.Components.StudioServer; c != nil {
		rows = append(rows, []string{"studio server", c.Version, "-", dashIf(m.latest.Server), dashIf(m.deps.Checkout.Server)})
	}
	if c := r.Components.Desktop; c != nil {
		rows = append(rows, []string{"desktop", dashIf(c.Version), "-", dashIf(m.latest.Desktop), dashIf(m.deps.Checkout.Desktop)})
	}
	rows = append(rows, []string{"engine", dashIf(r.Engine.InstalledVersion), fleet.EngineCell(r), "-", "-"})
	for _, line := range grid(rows) {
		b.WriteString(line + "\n")
	}
	fmt.Fprintf(&b, "\nhost: cpu %s · memory %s · %s conversation(s) running · relays %s\n",
		fleet.CPUCell(metrics(r)), fleet.MemCell(metrics(r)), fleet.RunningCell(r), fleet.RelaysCell(r))
	b.WriteString("\n" + styleTitle.Render("Devices") + "\n")
	b.WriteString(devicesSection(r))
	b.WriteString("\n" + styleTitle.Render("Accounts") + "\n")
	b.WriteString(hostAccountsSection(r, m.now()))
	b.WriteString("\n" + styleTitle.Render("Formats") + "\n")
	if len(r.Formats) == 0 {
		b.WriteString(styleDim.Render("this host reports no formats (its Ion predates format reporting)") + "\n")
	} else {
		frows := [][]string{{"FORMAT", "INSTALLED", "RUNNING", "RULE", "MEANING"}}
		for _, f := range r.Formats {
			running := dashIf(f.Running)
			if f.PendingRestart {
				running = styleWarn.Render(running + " (restart pending)")
			}
			frows = append(frows, []string{f.Owner + "/" + f.ID, dashIf(f.Installed), running, string(f.Rule), f.Meaning})
		}
		for _, line := range grid(frows) {
			b.WriteString(line + "\n")
		}
	}
	for _, p := range r.Problems {
		b.WriteString(styleDim.Render("unreadable: "+p) + "\n")
	}
	b.WriteString("\n" + styleDim.Render(keys))
	return b.String()
}

func (m Model) compatView() string {
	var b strings.Builder
	b.WriteString(m.header())
	refs := fleet.Comparable(m.statuses)
	if len(refs) == 0 {
		b.WriteString("No host reports its formats yet (their Ion predates format reporting). Deploy to update them.\n")
		b.WriteString("\n" + styleDim.Render("esc back"))
		return b.String()
	}
	idx := m.compatIndex % len(refs)
	mtx := fleet.BuildMatrix(m.statuses, refs[idx])
	b.WriteString(styleTitle.Render(mtx.Format.String()) + styleDim.Render(fmt.Sprintf(" (%s) · format %d of %d", mtx.Rule, idx+1, len(refs))) + "\n")
	b.WriteString(styleDim.Render(mtx.Meaning) + "\n\n")
	b.WriteString(styleDim.Render("rows send to columns") + "\n")
	rows := [][]string{append([]string{""}, mtx.Columns...)}
	for i, row := range mtx.Cells {
		line := []string{mtx.Rows[i]}
		for _, c := range row {
			switch c.Verdict {
			case fleet.VerdictOK:
				line = append(line, styleGood.Render("can send"))
			case fleet.VerdictBlocked:
				line = append(line, styleBad.Render("can't send"))
			default:
				line = append(line, styleDim.Render("unknown"))
			}
		}
		rows = append(rows, line)
	}
	for _, line := range grid(rows) {
		b.WriteString(line + "\n")
	}
	for _, row := range mtx.Cells {
		for _, c := range row {
			if c.Verdict == fleet.VerdictBlocked {
				b.WriteString(styleBad.Render(fmt.Sprintf("  %s → %s: %s", c.From, c.To, c.Reason)) + "\n")
			}
		}
	}
	b.WriteString("\n" + styleDim.Render("←→ format · esc back"))
	return b.String()
}

func (m Model) deployView() string {
	var b strings.Builder
	b.WriteString(m.header())
	b.WriteString(styleTitle.Render("Deploy") + styleDim.Render(" "+hostNames(m.deployHosts)) + "\n\n")
	if m.editingSource {
		b.WriteString("Source: " + m.sourceInput + "▏\n")
		b.WriteString(styleDim.Render("dev (the fleet file's checkout), release, or a path to an Ion checkout (. and ~ work)") + "\n")
		if m.sourceErr != "" {
			b.WriteString(styleBad.Render(m.sourceErr) + "\n")
		}
		b.WriteString("\n" + styleDim.Render("enter deploy from this source · ctrl+u clear · esc cancel"))
		return b.String()
	}
	b.WriteString("Source: " + m.source + "\n\n")
	switch {
	case m.preparing:
		b.WriteString("reading the fleet and the new build's formats…\n")
	case m.prepared == nil:
		b.WriteString(styleDim.Render("nothing to deploy") + "\n")
	default:
		for _, line := range m.prepared.PlanLines() {
			if strings.Contains(line, "BLOCKED:") || strings.Contains(line, "can no longer") {
				line = styleBad.Render(line)
			}
			b.WriteString(line + "\n")
		}
		if m.prepared.Preflight.Blocks() {
			state := "not allowed"
			if m.allowDowngrade {
				state = styleWarn.Render("allowed")
			}
			b.WriteString("\nstored-data downgrade: " + state + "\n")
		}
	}
	if len(m.stages) > 0 {
		b.WriteString("\n")
		rows := [][]string{{"HOST", "STAGE", "DETAIL"}}
		for _, t := range m.targetsInPlan() {
			e := m.stages[t]
			stage := dashIf(e.Stage)
			switch e.Stage {
			case fleet.StageFailed:
				stage = styleBad.Render(stage)
			case fleet.StageDone:
				stage = styleGood.Render(stage)
			}
			rows = append(rows, []string{t, stage, e.Detail})
		}
		for _, line := range grid(rows) {
			b.WriteString(line + "\n")
		}
	}
	for _, r := range m.results {
		b.WriteString(styleDim.Render(fmt.Sprintf("%s log: %s", r.Host, r.LogPath)) + "\n")
		for _, note := range []string{r.FellBack, r.Tidy} {
			if note != "" {
				b.WriteString(styleDim.Render(fmt.Sprintf("%s: %s", r.Host, note)) + "\n")
			}
		}
	}
	switch {
	case m.deploying:
		b.WriteString("\n" + styleDim.Render("deploying; a host that asks for its sudo password takes over this terminal when its turn comes"))
	case m.results != nil:
		b.WriteString("\n" + styleDim.Render("esc back"))
	default:
		b.WriteString("\n" + styleDim.Render("y deploy · e change the source · D allow a stored-data downgrade · esc back"))
	}
	return b.String()
}

func (m Model) targetsInPlan() []string {
	if m.prepared == nil {
		return nil
	}
	out := make([]string, 0, len(m.prepared.Targets))
	for _, t := range m.prepared.Targets {
		out = append(out, t.Host.Name)
	}
	return out
}

func (m Model) confirmView() string {
	var b strings.Builder
	b.WriteString(m.header())
	if m.confirm == nil {
		return b.String()
	}
	b.WriteString(styleTitle.Render(fmt.Sprintf("%s on %s?", m.confirm.op, hostNames(m.confirm.hosts))) + "\n")
	for _, h := range m.confirm.hosts {
		if m.confirm.op == "restart" && h.Kind == fleet.KindDesktop {
			b.WriteString(styleWarn.Render(h.Name+": Ion quits and reopens; its running conversations stop") + "\n")
		}
		if m.confirm.op == "relay set" {
			p := m.deps.Config.ProfileOf(h)
			fmt.Fprintf(&b, "%s: relay %s\n", h.Name, dashIf(p.Relay))
		}
	}
	b.WriteString("\n" + styleDim.Render("y go ahead · any other key cancels"))
	return b.String()
}

// devicesSection lists the host's paired devices, the fleet's own pairing
// left out, connected ones first.
func devicesSection(r *studiostatus.Report) string {
	if r.Devices == nil {
		return styleDim.Render("not read (the host's server is down, or its Ion predates device reporting)") + "\n"
	}
	rows := [][]string{{"DEVICE", "KIND", "CONNECTED", "LAST SEEN", "ADMIN"}}
	var on, off [][]string
	for _, d := range r.Devices {
		if d.Self {
			continue
		}
		name := d.Label
		if name == "" {
			name = "unnamed"
		}
		admin := ""
		if d.Admin {
			admin = "admin"
		}
		if d.Connected {
			on = append(on, []string{name, studiostatus.DeviceKindName(d.Kind), styleGood.Render("now"), "-", admin})
		} else {
			off = append(off, []string{name, studiostatus.DeviceKindName(d.Kind), "no", ago(d.LastSeen), admin})
		}
	}
	if len(on)+len(off) == 0 {
		return styleDim.Render("no devices paired") + "\n"
	}
	var b strings.Builder
	for _, line := range grid(append(append(rows, on...), off...)) {
		b.WriteString(line + "\n")
	}
	return b.String()
}

// ago is how long before now a Unix-ms time was, coarsely.
func ago(ms int64) string {
	if ms <= 0 {
		return "-"
	}
	d := time.Since(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 48*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	default:
		return fmt.Sprintf("%dd ago", int(d.Hours()/24))
	}
}

func metrics(r *studiostatus.Report) *studiostatus.HostMetrics {
	if r == nil {
		return nil
	}
	return r.Metrics
}

func dashIf(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

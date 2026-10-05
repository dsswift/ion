package fleet

import (
	"fmt"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// The cells a fleet table shows for one host, shared by `ion fleet status`
// and the dashboard so both say the same thing. "-" is unknown or absent.

// KindCell is what the host has installed. A host whose Ion predates the full
// report shows the fleet file's kind, marked unconfirmed.
func KindCell(st HostStatus) string {
	r := st.Report
	if r == nil {
		return st.Host.Kind
	}
	if r.Kind == studiostatus.KindNone && Legacy(r) {
		return st.Host.Kind + "?"
	}
	return dash(r.Kind)
}

// DesktopCell is the installed desktop version.
func DesktopCell(r *studiostatus.Report) string {
	if r == nil || r.Components.Desktop == nil {
		return "-"
	}
	return dash(r.Components.Desktop.Version)
}

// ServerCell is the Studio Server version: the bundle's, else the one the
// desktop carries.
func ServerCell(r *studiostatus.Report) string {
	switch {
	case r == nil:
		return "-"
	case r.Components.StudioServer != nil:
		return dash(r.Components.StudioServer.Version)
	case r.Components.Desktop != nil:
		return dash(r.Components.Desktop.ServerVersion)
	}
	return "-"
}

// EngineCell is the running engine, flagged when a restart is pending.
func EngineCell(r *studiostatus.Report) string {
	switch {
	case r == nil:
		return "-"
	case r.Engine.Running && r.Engine.Version == "":
		return "running"
	case !r.Engine.Running && Legacy(r):
		return "unknown"
	case !r.Engine.Running:
		return "down"
	case r.Engine.PendingRestart:
		return r.Engine.Version + " (restart pending)"
	}
	return r.Engine.Version
}

// FormatCell is the host's version of one format now.
func FormatCell(r *studiostatus.Report, f FormatRef) string {
	if r == nil {
		return "-"
	}
	if fs, ok := r.Format(f.Owner, f.ID); ok {
		return dash(fs.Effective())
	}
	return "-"
}

// CPUCell is the host's CPU use.
func CPUCell(m *studiostatus.HostMetrics) string {
	if m == nil || m.CPUUtilization == nil {
		return "-"
	}
	return fmt.Sprintf("%.0f%%", *m.CPUUtilization*100)
}

// MemCell is the host's memory in use.
func MemCell(m *studiostatus.HostMetrics) string {
	if m == nil || m.MemoryTotalBytes == 0 {
		return "-"
	}
	used := m.MemoryTotalBytes - m.MemoryAvailableBytes
	return fmt.Sprintf("%.0f%% of %s", float64(used)/float64(m.MemoryTotalBytes)*100, HumanBytes(m.MemoryTotalBytes))
}

// RunningCell is the conversations with an agent running now.
func RunningCell(r *studiostatus.Report) string {
	if r == nil || r.RunningConversations == nil {
		return "-"
	}
	return fmt.Sprint(*r.RunningConversations)
}

// DevicesCell is the host's paired devices and how many are connected now,
// "2 · 1 on"; "-" when the host's server was not asked.
func DevicesCell(r *studiostatus.Report) string {
	if r == nil || r.Devices == nil {
		return "-"
	}
	paired, connected := studiostatus.DeviceCounts(r.Devices)
	if paired == 0 {
		return "0"
	}
	return fmt.Sprintf("%d · %d on", paired, connected)
}

// RelaysCell lists the host's relays by host name.
func RelaysCell(r *studiostatus.Report) string {
	if r == nil || len(r.Relays) == 0 {
		return "-"
	}
	names := make([]string, 0, len(r.Relays))
	for _, u := range r.Relays {
		names = append(names, strings.TrimPrefix(strings.TrimPrefix(u, "wss://"), "ws://"))
	}
	return strings.Join(names, ",")
}

// HumanBytes is n in binary units.
func HumanBytes(n uint64) string {
	const unit = 1024
	if n < unit {
		return fmt.Sprintf("%d B", n)
	}
	div, exp := uint64(unit), 0
	for m := n / unit; m >= unit; m /= unit {
		div *= unit
		exp++
	}
	return fmt.Sprintf("%.1f %ciB", float64(n)/float64(div), "KMGTPE"[exp])
}

func dash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// Accounts is one row per provider account across the hosts that reported
// any, in host order.
func Accounts(statuses []HostStatus) []studiostatus.FleetAccount {
	byHost := map[string][]studiostatus.Account{}
	var order []string
	for _, st := range statuses {
		if st.Report == nil || len(st.Report.Accounts) == 0 {
			continue
		}
		byHost[st.Host.Name] = st.Report.Accounts
		order = append(order, st.Host.Name)
	}
	return studiostatus.MergeAccounts(byHost, order)
}

// AgoCell is how long ago a Unix-millisecond time was, in its largest
// whole unit.
func AgoCell(ms int64, now time.Time) string {
	d := now.Sub(time.UnixMilli(ms))
	switch {
	case d < time.Minute:
		return "just now"
	case d < time.Hour:
		return fmt.Sprintf("%dm ago", int(d.Minutes()))
	case d < 24*time.Hour:
		return fmt.Sprintf("%dh ago", int(d.Hours()))
	}
	return fmt.Sprintf("%dd ago", int(d.Hours()/24))
}

// LimitCell is one of an account's usage limits: the percent used and when
// it resets. A limit read before a reset that has since passed says so,
// because its number is no longer true. A weekly_model limit names its model.
func LimitCell(a studiostatus.Account, kind string, now time.Time) string {
	l, ok := a.Limit(kind, "")
	if !ok {
		return "-"
	}
	name := ""
	if kind == "weekly_model" && l.Label != "" {
		name = l.Label + " "
	}
	resets, err := time.Parse(time.RFC3339, l.ResetsAt)
	if err != nil {
		return fmt.Sprintf("%s%.0f%%", name, l.Percent)
	}
	if !resets.After(now) && time.UnixMilli(l.FetchedAt).Before(resets) {
		return name + "reset since last read"
	}
	left := resets.Sub(now)
	in := fmt.Sprintf("%dm", int(left.Minutes()))
	switch {
	case left >= 24*time.Hour:
		in = fmt.Sprintf("%dd", int(left.Hours()/24))
	case left >= time.Hour:
		in = fmt.Sprintf("%dh", int(left.Hours()))
	}
	return fmt.Sprintf("%s%.0f%% (resets in %s)", name, l.Percent, in)
}

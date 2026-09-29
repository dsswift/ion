package fleet

import (
	"fmt"
	"sort"
	"strconv"
	"strings"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Verdict is whether a pair of hosts can work together over one format.
type Verdict string

const (
	VerdictOK      Verdict = "ok"
	VerdictBlocked Verdict = "blocked"
	VerdictUnknown Verdict = "unknown"
)

// FormatRef names one format.
type FormatRef struct {
	Owner string `json:"owner"`
	ID    string `json:"id"`
}

func (f FormatRef) String() string { return f.Owner + "/" + f.ID }

// TransferFormat is the one the fleet cares about most: moving conversations.
var TransferFormat = FormatRef{Owner: compat.OwnerServer, ID: "transfer-archive"}

// StudioWireFormat is the protocol a desktop client speaks to a server.
var StudioWireFormat = FormatRef{Owner: compat.OwnerServer, ID: "studio-wire"}

// Cell is one directed pair: From sends (writes, or connects) to To.
type Cell struct {
	From        string  `json:"from"`
	To          string  `json:"to"`
	Verdict     Verdict `json:"verdict"`
	FromVersion string  `json:"fromVersion,omitempty"`
	ToVersion   string  `json:"toVersion,omitempty"`
	Reason      string  `json:"reason,omitempty"`
}

// Matrix is one format across the fleet. Rows are senders, columns receivers.
type Matrix struct {
	Format  FormatRef   `json:"format"`
	Rule    compat.Rule `json:"rule"`
	Meaning string      `json:"meaning"`
	Rows    []string    `json:"rows"`
	Columns []string    `json:"columns"`
	Cells   [][]Cell    `json:"cells"`
}

// Judge applies a rule to a sender's and a receiver's version.
//
//   - exact: equal.
//   - accepts-previous: the receiver (a server) accepts its version and the
//     one before; the sender is a client.
//   - reader-at-least: the receiver reads every version up to its own.
func Judge(rule compat.Rule, from, to string) (Verdict, string) {
	if from == "" || to == "" {
		return VerdictUnknown, "a host does not report this format"
	}
	switch rule {
	case compat.RuleExact:
		if from == to {
			return VerdictOK, ""
		}
		return VerdictBlocked, fmt.Sprintf("writes %s, the other reads %s", from, to)
	case compat.RuleAcceptsPrevious, compat.RuleReaderAtLeast:
		f, errF := strconv.Atoi(from)
		t, errT := strconv.Atoi(to)
		if errF != nil || errT != nil {
			if from == to {
				return VerdictOK, ""
			}
			return VerdictUnknown, "versions are not comparable numbers"
		}
		if rule == compat.RuleAcceptsPrevious {
			if f == t || f == t-1 {
				return VerdictOK, ""
			}
			return VerdictBlocked, fmt.Sprintf("client speaks %d, server accepts %d and %d", f, t, t-1)
		}
		if t >= f {
			return VerdictOK, ""
		}
		return VerdictBlocked, fmt.Sprintf("writer is at %d, reader only reads up to %d", f, t)
	}
	return VerdictUnknown, "this format is not compared between hosts"
}

// effective is the host's version of a format now, and the format's rule and
// meaning as that host describes it.
func effective(st HostStatus, f FormatRef) (studiostatus.FormatStatus, bool) {
	if st.Report == nil {
		return studiostatus.FormatStatus{}, false
	}
	return st.Report.Format(f.Owner, f.ID)
}

// Comparable lists the formats compared between hosts, transfer first, then
// the Studio wire, then by owner and id.
func Comparable(statuses []HostStatus) []FormatRef {
	seen := map[FormatRef]bool{}
	var out []FormatRef
	for _, st := range statuses {
		if st.Report == nil {
			continue
		}
		for _, f := range st.Report.Formats {
			ref := FormatRef{f.Owner, f.ID}
			if seen[ref] || f.Rule == compat.RuleExternal || f.Rule == compat.RuleHostStorage {
				continue
			}
			seen[ref] = true
			out = append(out, ref)
		}
	}
	rank := func(r FormatRef) int {
		switch r {
		case TransferFormat:
			return 0
		case StudioWireFormat:
			return 1
		}
		return 2
	}
	sort.SliceStable(out, func(i, j int) bool {
		if rank(out[i]) != rank(out[j]) {
			return rank(out[i]) < rank(out[j])
		}
		return out[i].String() < out[j].String()
	})
	return out
}

// BuildMatrix judges every directed pair of hosts over one format. For the
// Studio wire the senders are the hosts with a desktop (the clients); for
// every other format every host both sends and receives.
func BuildMatrix(statuses []HostStatus, f FormatRef) Matrix {
	m := Matrix{Format: f}
	for _, st := range statuses {
		if fs, ok := effective(st, f); ok && m.Rule == "" {
			m.Rule, m.Meaning = fs.Rule, fs.Meaning
		}
	}
	var rows []HostStatus
	for _, st := range statuses {
		m.Columns = append(m.Columns, st.Host.Name)
		if f == StudioWireFormat && (st.Report == nil || st.Report.Components.Desktop == nil) {
			continue
		}
		rows = append(rows, st)
	}
	for _, from := range rows {
		m.Rows = append(m.Rows, from.Host.Name)
		fromFormat, _ := effective(from, f)
		var row []Cell
		for _, to := range statuses {
			toFormat, _ := effective(to, f)
			cell := Cell{From: from.Host.Name, To: to.Host.Name, FromVersion: fromFormat.Effective(), ToVersion: toFormat.Effective()}
			cell.Verdict, cell.Reason = Judge(m.Rule, cell.FromVersion, cell.ToVersion)
			if cell.Verdict == VerdictBlocked {
				utils.LogWithFields(utils.LevelInfo, logTag, "compatibility: blocked pair", map[string]any{"format": f.String(), "from": cell.From, "to": cell.To, "reason": cell.Reason})
			}
			row = append(row, cell)
		}
		m.Cells = append(m.Cells, row)
	}
	return m
}

// Drift reports the hosts whose version of a format differs from the one
// most of the fleet speaks. A tie picks the higher version as the norm.
func Drift(statuses []HostStatus, f FormatRef) map[string]bool {
	count := map[string]int{}
	for _, st := range statuses {
		if fs, ok := effective(st, f); ok && fs.Effective() != "" {
			count[fs.Effective()]++
		}
	}
	norm := ""
	for v, n := range count {
		if n > count[norm] || (n == count[norm] && v > norm) {
			norm = v
		}
	}
	out := map[string]bool{}
	for _, st := range statuses {
		if fs, ok := effective(st, f); ok && fs.Effective() != "" && fs.Effective() != norm {
			out[st.Host.Name] = true
		}
	}
	return out
}

// HostFlags are per-host warnings a fleet view shows beside the row.
func HostFlags(st HostStatus) []string {
	if st.Report == nil {
		return nil
	}
	var out []string
	if Legacy(st.Report) {
		out = append(out, PredatesFullReport)
	}
	// A host read only publicly says why its load and devices are blank.
	for _, p := range st.Report.Problems {
		if strings.HasPrefix(p, publicOnlyProblem) {
			out = append(out, p)
		}
	}
	if st.Report.Engine.MeetsMin != nil && !*st.Report.Engine.MeetsMin {
		if v := st.Report.Engine.Version; v != "" {
			out = append(out, fmt.Sprintf("engine %s is below this server's minimum %s", v, st.Report.Engine.MinVersion))
		} else {
			out = append(out, fmt.Sprintf("the server does not see an engine that meets its minimum %s", st.Report.Engine.MinVersion))
		}
	}
	if st.Report.Engine.PendingRestart {
		out = append(out, fmt.Sprintf("engine %s installed, %s still running", st.Report.Engine.InstalledVersion, st.Report.Engine.Version))
	}
	for _, f := range st.Report.Formats {
		if f.PendingRestart {
			out = append(out, fmt.Sprintf("%s/%s %s installed, %s running", f.Owner, f.ID, f.Installed, f.Running))
		}
	}
	return out
}

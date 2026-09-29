package fleet

import (
	"fmt"
	"strconv"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// PairChange is one directed pair whose verdict a deploy changes.
type PairChange struct {
	Format FormatRef `json:"format"`
	From   string    `json:"from"`
	To     string    `json:"to"`
	// Broken: it works now and will not after. Otherwise it is fixed.
	Broken bool   `json:"broken"`
	Reason string `json:"reason,omitempty"`
}

// Downgrade is a stored-data format a deploy would lower on a host.
type Downgrade struct {
	Host   string    `json:"host"`
	Format FormatRef `json:"format"`
	From   string    `json:"from"`
	To     string    `json:"to"`
}

// Preflight is what a deploy changes across the fleet, known before it runs.
type Preflight struct {
	Changes    []PairChange `json:"changes"`
	Downgrades []Downgrade  `json:"downgrades"`
	// Unknown names targets whose new build's formats could not be read, so
	// their effect cannot be judged.
	Unknown []string `json:"unknown"`
	// Unreadable names targets whose formats today are not known, and why,
	// so a downgrade on them cannot be judged. A host outside the deploy is
	// never named: the deploy changes no pair between two hosts it does not
	// touch.
	Unreadable []HostNote `json:"unreadable"`
	// Compared counts the hosts whose formats are known after the deploy.
	Compared int `json:"compared"`
}

// Why a target's formats today are not known.
const (
	// NoteDown: the host did not answer.
	NoteDown = "down"
	// NoteOld: the host answered, but its Ion predates reporting formats.
	NoteOld = "old"
)

// HostNote is a target the preflight could not read, and why.
type HostNote struct {
	Host   string `json:"host"`
	Reason string `json:"reason"`
	// Error is why a down host did not answer.
	Error string `json:"error,omitempty"`
}

// Blocks reports whether the deploy needs an explicit confirmation.
func (p Preflight) Blocks() bool { return len(p.Downgrades) > 0 }

// ComputePreflight compares the fleet now against the fleet after the
// targeted hosts run their new builds' formats.
func ComputePreflight(statuses []HostStatus, targets map[string][]compat.Format) Preflight {
	var pf Preflight
	after := make([]HostStatus, len(statuses))
	for i, st := range statuses {
		after[i] = st
		formats, targeted := targets[st.Host.Name]
		if !targeted {
			continue
		}
		switch {
		case st.Report == nil:
			pf.Unreadable = append(pf.Unreadable, HostNote{Host: st.Host.Name, Reason: NoteDown, Error: st.Error})
		case len(st.Report.Formats) == 0:
			pf.Unreadable = append(pf.Unreadable, HostNote{Host: st.Host.Name, Reason: NoteOld})
		}
		if len(formats) == 0 {
			pf.Unknown = append(pf.Unknown, st.Host.Name)
			continue
		}
		r := studiostatus.Report{SchemaVersion: compat.StatusReportVersion, Formats: studiostatus.MergeFormats(nil, formats)}
		if st.Report != nil {
			r.Components = st.Report.Components
			pf.Downgrades = append(pf.Downgrades, downgrades(st.Host.Name, st.Report.Formats, formats)...)
		}
		after[i].Report = &r
	}
	for _, st := range after {
		if st.Report != nil && len(st.Report.Formats) > 0 {
			pf.Compared++
		}
	}
	refs := Comparable(append(append([]HostStatus{}, statuses...), after...))
	for _, ref := range refs {
		before, next := BuildMatrix(statuses, ref), BuildMatrix(after, ref)
		for i, row := range next.Cells {
			for j, cell := range row {
				old, ok := cellAt(before, next.Rows[i], next.Columns[j])
				if !ok || old.Verdict == cell.Verdict || old.Verdict == VerdictUnknown || cell.Verdict == VerdictUnknown {
					continue
				}
				change := PairChange{Format: ref, From: cell.From, To: cell.To, Broken: cell.Verdict == VerdictBlocked}
				if change.Broken {
					change.Reason = cell.Reason
				}
				pf.Changes = append(pf.Changes, change)
			}
		}
	}
	return pf
}

func cellAt(m Matrix, row, col string) (Cell, bool) {
	for i, r := range m.Rows {
		if r != row {
			continue
		}
		for _, c := range m.Cells[i] {
			if c.To == col {
				return c, true
			}
		}
	}
	return Cell{}, false
}

// downgrades lists stored-data formats the new build writes at a lower
// version than the host holds now.
func downgrades(host string, current []studiostatus.FormatStatus, next []compat.Format) []Downgrade {
	var out []Downgrade
	for _, f := range next {
		if f.Rule != compat.RuleHostStorage {
			continue
		}
		for _, cur := range current {
			if cur.Owner != f.Owner || cur.ID != f.ID {
				continue
			}
			// The host holds data at the higher of what is installed and what
			// runs: a pending restart has not written the newer version yet,
			// and a running build may be newer than an installed one it lost.
			held := cur.Installed
			if held == "" || versionLess(held, cur.Running) {
				held = cur.Running
			}
			if versionLess(f.Version, held) {
				out = append(out, Downgrade{Host: host, Format: FormatRef{f.Owner, f.ID}, From: held, To: f.Version})
			}
		}
	}
	return out
}

func versionLess(a, b string) bool {
	x, errA := strconv.Atoi(a)
	y, errB := strconv.Atoi(b)
	return errA == nil && errB == nil && x < y
}

// Lines renders the preflight as plain sentences for a terminal: what the
// deploy changes about which hosts can work with which.
func (p Preflight) Lines() []string {
	var out []string
	for _, d := range p.Downgrades {
		out = append(out, fmt.Sprintf("BLOCKED: this would move %s's stored %s back from version %s to %s, which the older build may misread. Add --allow-downgrade to deploy anyway.", d.Host, d.Format.ID, d.From, d.To))
	}
	for _, c := range p.Changes {
		if c.Broken {
			out = append(out, fmt.Sprintf("After this deploy, %s can no longer %s %s (%s).", c.From, verbFor(c.Format), c.To, c.Reason))
		} else {
			out = append(out, fmt.Sprintf("After this deploy, %s can %s %s again.", c.From, verbFor(c.Format), c.To))
		}
	}
	for _, n := range p.Unreadable {
		if n.Reason == NoteDown {
			reason := ""
			if n.Error != "" {
				reason = " (" + n.Error + ")"
			}
			out = append(out, fmt.Sprintf("%s isn't answering%s, so the deploy will probably fail there.", n.Host, reason))
			continue
		}
		out = append(out, fmt.Sprintf("%s runs an Ion too old to report its formats, so a stored-data downgrade can't be checked.", n.Host))
	}
	for _, h := range p.Unknown {
		out = append(out, fmt.Sprintf("The build going to %s could not be read, so its compatibility with other hosts can't be checked.", h))
	}
	if len(out) > 0 {
		return append([]string{"Compatibility:"}, indent(out)...)
	}
	if p.Compared < 2 {
		// Nothing to compare and nothing to say.
		return nil
	}
	return []string{"Compatibility: unchanged. Every host that can transfer conversations to, or connect to, another host today still can after this deploy."}
}

// verbFor says what one host does to another over a format.
func verbFor(f FormatRef) string {
	switch f {
	case TransferFormat:
		return "send conversations to"
	case StudioWireFormat:
		return "connect its desktop to"
	case FormatRef{Owner: "server", ID: "backup-archive"}:
		return "restore its backups on"
	}
	return "work with (" + f.ID + ")"
}

func indent(lines []string) []string {
	out := make([]string, len(lines))
	for i, l := range lines {
		out[i] = "  " + l
	}
	return out
}

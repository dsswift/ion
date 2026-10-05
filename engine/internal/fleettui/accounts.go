package fleettui

import (
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// accountsSection is the provider accounts across the fleet: one row each,
// its usage limits, and the hosts it is signed in on now (plain) or was
// seen on in the last 30 days (dim).
func accountsSection(statuses []fleet.HostStatus, now time.Time) string {
	accounts := fleet.Accounts(statuses)
	if len(accounts) == 0 {
		return ""
	}
	rows := [][]string{{"ACCOUNT", "PLAN", "7-DAY MODEL", "5-HOUR", "7-DAY", "HOSTS"}}
	for _, a := range accounts {
		rows = append(rows, accountRow(a.Account, a.SignedIn, machines(a.Machines), now))
	}
	var b strings.Builder
	b.WriteString(styleTitle.Render("Accounts") + "\n")
	lines := grid(rows)
	b.WriteString(styleDim.Render(lines[0]) + "\n")
	for _, line := range lines[1:] {
		b.WriteString(line + "\n")
	}
	return b.String()
}

// hostAccountsSection is the accounts one host has seen.
func hostAccountsSection(r *studiostatus.Report, now time.Time) string {
	if r.Accounts == nil {
		return styleDim.Render("not read (the host's Ion predates account reporting)") + "\n"
	}
	if len(r.Accounts) == 0 {
		return styleDim.Render("no provider account seen in the last 30 days") + "\n"
	}
	rows := [][]string{{"ACCOUNT", "PLAN", "7-DAY MODEL", "5-HOUR", "7-DAY", "HERE"}}
	for _, a := range r.Accounts {
		here := styleGood.Render("signed in")
		if !a.SignedIn {
			here = styleDim.Render("seen " + fleet.AgoCell(a.LastSeen, now))
		}
		rows = append(rows, accountRow(a, a.SignedIn, here, now))
	}
	var b strings.Builder
	for _, line := range grid(rows) {
		b.WriteString(line + "\n")
	}
	return b.String()
}

func accountRow(a studiostatus.Account, signedIn bool, last string, now time.Time) []string {
	plan := dashIf(a.Label)
	if !signedIn {
		plan += " · last seen " + fleet.AgoCell(a.LastSeen, now)
	}
	return []string{a.Name(), plan, limitCell(a, "weekly_model", now), limitCell(a, "session", now), limitCell(a, "weekly", now), last}
}

// limitCell warns from 70% used and is bad from 90%.
func limitCell(a studiostatus.Account, kind string, now time.Time) string {
	text := fleet.LimitCell(a, kind, now)
	l, ok := a.Limit(kind, "")
	switch {
	case !ok || strings.Contains(text, "reset since"):
		return styleDim.Render(text)
	case l.Percent >= 90:
		return styleBad.Render(text)
	case l.Percent >= 70:
		return styleWarn.Render(text)
	}
	return text
}

func machines(ms []studiostatus.AccountMachine) string {
	out := make([]string, 0, len(ms))
	for _, m := range ms {
		if m.SignedIn {
			out = append(out, m.Host)
		} else {
			out = append(out, styleDim.Render("("+m.Host+")"))
		}
	}
	return strings.Join(out, ", ")
}

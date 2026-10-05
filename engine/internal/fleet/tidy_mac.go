package fleet

import (
	"context"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// A Mac desktop that replaces its own app does so as its user, with no
// password. An app a package installed belongs to root, which that user can
// rename but not delete, so the old app is left set aside beside the new one.
// A deploy that can reach the host over SSH tidies that up with sudo: it
// removes every set-aside app and gives the installed app to the user Ion
// runs as, so the next self-install replaces it outright.

// macSetAside is where a replaced app is set aside, and the numbered names
// used while an earlier one still holds that name.
const macSetAside = "/Applications/.Ion.app.previous"

// macTidyFind prints one line per thing to tidy: "aside <path>" for each
// set-aside app, and "owner <user>" when the installed app belongs to
// someone other than the SSH user.
const macTidyFind = `for p in '` + macSetAside + `' '` + macSetAside + `'.*; do [ -e "$p" ] && echo "aside $p"; done
o="$(stat -f %Su '` + desktopApp + `' 2>/dev/null)"; [ -n "$o" ] && [ "$o" != "$(id -un)" ] && echo "owner $o"
exit 0`

// macTakeOwnership gives the installed app to the SSH user, the user Ion
// runs as on the host; sudo is the command prefix that runs it as root.
func macTakeOwnership(sudo string) string {
	return sudo + ` chown -R "$(id -un)" '` + desktopApp + `'`
}

// macTidyPlan is what macTidyFind found.
type macTidyPlan struct {
	aside []string
	owner string
}

func parseMacTidy(out string) macTidyPlan {
	var p macTidyPlan
	for _, line := range strings.Split(out, "\n") {
		kind, value, ok := strings.Cut(strings.TrimSpace(line), " ")
		switch {
		case !ok:
		case kind == "aside":
			// What is listed here is removed with sudo: only a set-aside app is taken.
			if value == macSetAside || strings.HasPrefix(value, macSetAside+".") {
				p.aside = append(p.aside, value)
			}
		case kind == "owner":
			p.owner = value
		}
	}
	return p
}

func (p macTidyPlan) empty() bool { return len(p.aside) == 0 && p.owner == "" }

// script runs the tidy with sudo given as the command prefix.
func (p macTidyPlan) script(sudo string) string {
	var cmds []string
	if len(p.aside) > 0 {
		quoted := make([]string, len(p.aside))
		for i, a := range p.aside {
			quoted[i] = shellQuote(a)
		}
		cmds = append(cmds, sudo+" rm -rf "+strings.Join(quoted, " "))
	}
	if p.owner != "" {
		cmds = append(cmds, macTakeOwnership(sudo))
	}
	return strings.Join(cmds, " && ")
}

// summary says what the tidy did, for the deploy's result.
func (p macTidyPlan) summary() string {
	var parts []string
	if n := len(p.aside); n == 1 {
		parts = append(parts, "removed 1 old app")
	} else if n > 1 {
		parts = append(parts, fmt.Sprintf("removed %d old apps", n))
	}
	if p.owner != "" {
		parts = append(parts, "took the app back from "+p.owner)
	}
	return strings.Join(parts, "; ")
}

// tidyTargets are the deployed targets a tidy applies to: a Mac desktop
// that installed on itself and has an SSH target to reach it with. An
// install over SSH needs none: its package removes set-aside apps and the
// install hands the app to the SSH user.
func tidyTargets(targets []Target, results []Result) []int {
	var out []int
	for i, t := range targets {
		if t.Self && results[i].OK && results[i].FellBack == "" && t.Component == ComponentDesktop && t.GOOS == "darwin" && t.Host.SSH != "" {
			out = append(out, i)
		}
	}
	return out
}

// tidyMac tidies one host after its desktop installed itself. It never
// fails the deploy, which already succeeded: what it could not do is the
// result's Tidy note, with the remedy.
func (d *Deployer) tidyMac(ctx context.Context, p *Prepared, t Target, res *Result) {
	h := t.Host
	logFile, err := os.OpenFile(res.LogPath, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0o600)
	if err != nil {
		res.Tidy = "not tidied: " + err.Error()
		return
	}
	defer logFile.Close() //nolint:errcheck // log file; the outcome is in the result
	w := newStampWriter(d.echoed(logFile, h.Name, []string{h.Name}))
	log := newInstallLog(w, h.Name, InstallOptions{})
	fields := map[string]any{"fleet_host": h.Name}
	defer func() {
		fields["tidy"] = res.Tidy
		utils.LogWithFields(utils.LevelInfo, logTag, "mac desktop tidy finished", fields)
	}()

	log.step("look for old apps on %s", h.Name)
	out, err := hostCmd(ctx, d.Runner, h, false, macTidyFind, nil, log)
	if err != nil {
		res.Tidy = "could not look for old apps: " + err.Error()
		return
	}
	plan := parseMacTidy(string(out))
	fields["aside"], fields["owner"] = len(plan.aside), plan.owner
	if plan.empty() {
		log.note("nothing to tidy on %s", h.Name)
		return
	}
	log.note("to tidy on %s: %d old app(s); app owner %q", h.Name, len(plan.aside), plan.owner)

	if _, err := hostCmd(ctx, d.Runner, h, false, "sudo -n true", nil, log); err == nil {
		fields["sudo"] = "passwordless"
		log.step("tidy on %s", h.Name)
		if _, err := hostCmd(ctx, d.Runner, h, false, plan.script("sudo -n"), nil, log); err != nil {
			res.Tidy = "tidy failed: " + err.Error()
			return
		}
		res.Tidy = plan.summary()
		return
	}
	if !p.Request.Install.AskSudo && !h.AskSudo || !p.Request.Terminal {
		fields["sudo"] = "unavailable"
		res.Tidy = fmt.Sprintf("old app left in place: sudo on %s needs a password; deploy from a terminal with --ask-sudo to remove it", h.Name)
		return
	}
	fields["sudo"] = "terminal"
	log.step("tidy on %s (waiting for the sudo password)", h.Name)
	banner := fmt.Sprintf("ion fleet is removing an old Ion app on %s. That needs sudo.\nType your password on %s at the prompt below.", h.Name, h.Name)
	log.note("%s", banner)
	r := terminalRunner{Runner: d.Runner, exec: d.exec}
	if err := r.RunTerminal(ctx, h, plan.script("sudo -p "+shellQuote(macSudoPrompt(h))), banner, io.Writer(w)); err != nil {
		res.Tidy = "tidy failed: " + err.Error()
		return
	}
	res.Tidy = plan.summary()
}

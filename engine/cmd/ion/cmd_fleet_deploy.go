package main

// cmd_fleet_deploy.go — `ion fleet deploy`: show the plan and what it changes
// across the fleet, then build once per platform and deploy (--dry-run stops
// after the plan).

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"text/tabwriter"

	"github.com/dsswift/ion/engine/internal/fleet"
	"github.com/dsswift/ion/engine/internal/utils"
)

const fleetDeployUsage = `Usage: ion fleet deploy HOST... --source dev|release|PATH [--component server|desktop] [options]
       ion fleet deploy --to [user@]HOST --kind desktop|server [--source dev|release|PATH] [options]

Redeploys the hosts. The component defaults to each host's kind: a server host
gets the Studio Server bundle, a desktop host the Ion desktop app. The plan and
what it changes between hosts (transfer, Studio wire, stored data) print first,
then the deploy runs. A fleet deploy quits a running desktop.

A host that answers on its Studio connection installs on itself: it downloads
the release, or takes the build this deploy sends it. That needs no SSH, so it
works through a relay. A host that does not answer, a Windows host, and a first
install deploy over SSH.

--to deploys one host that need not be in the fleet file, the way
` + "`make deploy-studio-desktop`" + ` and ` + "`make deploy-studio-server`" + ` do. Its steps
print as they run, and its last line is a JSON receipt. A running desktop
stops it unless --quit-ion is given.

  --source dev       Build the fleet file's checkout once per platform, then deploy it
  --source PATH      Build and ship the Ion checkout at PATH instead: "." is this folder,
                     so a bench or any worktree deploys what it holds, with no fixed branch
  --source release   Install the newest published release
  --release-for H,H  These hosts install the newest release even though the others take the
                     build: the way out for a host nothing can build for
  --pkg PATH         Install this desktop package (.pkg) or Windows installer (.exe)
  --no-build         Install the newest build already in the checkout
  --build-dir DIR    With --to: where the host builds when it is the builder (an absolute path,
                     or one under its home)
  --over-ssh         Install over SSH even on a host that would install on itself
  --events           Print the plan, every step, every log line, and each result as one JSON
                     object per line
  --run-id ID        Name this deploy; one is made up otherwise
  --dry-run          Print the plan and what it changes, and deploy nothing
  --allow-downgrade  Go ahead even though a host's stored data would move to an older format
` + fleet.InstallArgsUsage + `
Hosts deploy in parallel (the fleet file's concurrency, 4 by default). Hosts marked
askSudo deploy last, one at a time, on this terminal. A host that fails to install
on itself is then installed over SSH when it has an SSH target. Each host's log is under
~/.ion/fleet/logs.

A host that cannot be deployed (nothing can build for it, it does not answer) is
named in the plan with why, and the deploy goes on with the others. This machine's
server is told of the deploy as it runs: Studio shows it, and so does every Fleet
Hub the server reports to.
`

// newDeployer is the deployer the CLI and the dashboard share.
func newDeployer(cfg fleet.Config, progress func(fleet.Event)) *fleet.Deployer {
	return &fleet.Deployer{
		Config:    cfg,
		Runner:    fleet.ExecRunner{},
		Collector: fleetCollector(),
		OpenLink:  fleetStudio().Opener(),
		Artifacts: fleet.Artifacts{CacheDir: filepath.Join(fleet.StateDir(), "cache")},
		LogDir:    filepath.Join(fleet.StateDir(), "logs"),
		Progress:  progress,
	}
}

func fleetDeployCommand(names []string, flags map[string]string) error {
	adHoc := flagValue(flags, "to") != ""
	if flags["help"] == "true" || (len(names) == 0 && !adHoc) {
		fmt.Print(fleetDeployUsage)
		if len(names) == 0 && flags["help"] != "true" {
			return errors.New("name the hosts to deploy, or one with --to")
		}
		return nil
	}
	install, rest, err := fleet.ParseInstallArgs(deployArgs(), fleet.InstallOptions{QuitIon: !adHoc})
	if err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelDebug, "fleet", "deploy arguments", map[string]any{"not_install_flags": rest})
	if install.Relay != "" && !install.RelayOIDC && install.RelayKey == "" {
		install.RelayKey = os.Getenv("ION_RELAY_KEY")
	}
	cfg, err := loadFleet()
	if err != nil {
		return err
	}
	var hosts []fleet.Host
	if adHoc {
		if len(names) > 0 {
			return errors.New("--to deploys one host; name no others")
		}
		var host fleet.Host
		if cfg, host, err = adHocHost(cfg, flagValue(flags, "to"), flagValue(flags, "kind"), install.AskSudo, flagValue(flags, "build-dir")); err != nil {
			return err
		}
		hosts = []fleet.Host{host}
		install.SudoHint = "pass --ask-sudo from a terminal to be asked for the password instead"
	} else if hosts, err = cfg.Select(names); err != nil {
		return err
	}
	source, checkout := fleet.SourceDev, ""
	if s := flagValue(flags, "source"); s != "" || flagValue(flags, "pkg") == "" {
		if source, checkout, err = fleet.ResolveSource(s, cfg); err != nil {
			return err
		}
	}
	var releaseHosts []string
	for _, name := range strings.Split(flagValue(flags, "release-for"), ",") {
		if name = strings.TrimSpace(name); name == "" {
			continue
		}
		h, ok := cfg.Host(name)
		if !ok {
			return fmt.Errorf("--release-for: no host named %q in the fleet", name)
		}
		releaseHosts = append(releaseHosts, h.Name)
	}
	req := fleet.Request{
		Hosts: hosts, Source: source, Checkout: checkout, Component: flagValue(flags, "component"),
		AllowDowngrade: flags["allow-downgrade"] == "true", Install: install,
		Artifact: absPath(flagValue(flags, "pkg")), NoBuild: flags["no-build"] == "true", Terminal: stdinIsTerminal(),
		// A --to deploy reaches a host by its SSH target, paired or not.
		ForceSSH:     flags["over-ssh"] == "true" || adHoc,
		ReleaseHosts: releaseHosts,
	}
	// A stopped deploy ends its builds and installs, and says it was stopped.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	runID := flagValue(flags, "run-id")
	if runID == "" {
		runID = fleet.NewDeployID()
	}
	// --events: one JSON object per line, for a program driving the deploy.
	events := flags["events"] == "true"
	out := &lineOut{}
	d := newDeployer(cfg, func(e fleet.Event) {
		switch {
		case events:
			out.emit(map[string]any{"event": "stage", "host": e.Host, "stage": e.Stage, "detail": e.Detail})
		case e.Detail != "":
			out.printf("%s: %s: %s\n", e.Host, e.Stage, e.Detail)
		default:
			out.printf("%s: %s\n", e.Host, e.Stage)
		}
	})
	if events {
		d.LogLine = func(hosts []string, line string) {
			out.emit(map[string]any{"event": "log", "hosts": hosts, "line": line})
		}
	}
	if adHoc {
		d.Echo = os.Stderr
	}
	if !events {
		fmt.Println("reading the fleet and the new build's formats…")
	}
	prepared, err := d.Prepare(ctx, req)
	if err != nil {
		return err
	}
	if events {
		out.emit(planEvent(prepared, runID, req.AllowDowngrade))
	} else {
		fmt.Println()
		for _, line := range prepared.PlanLines() {
			fmt.Println(line)
		}
	}
	if prepared.Preflight.Blocks() && !req.AllowDowngrade {
		return errors.New("a host's stored data would move to an older format; rerun with --allow-downgrade to go ahead")
	}
	if flags["dry-run"] == "true" {
		if !events {
			fmt.Println("\nDry run: nothing was deployed.")
		}
		return nil
	}
	if !events {
		fmt.Println()
	}
	reporter := fleet.NewDeployReporter()
	results, err := d.RunTracked(ctx, prepared, runID, reporter.Post)
	reporter.Close()
	if err != nil {
		return err
	}
	if events {
		var failed []string
		for _, r := range results {
			out.emit(map[string]any{"event": "result", "host": r.Host, "ok": r.OK, "error": r.Error, "logPath": r.LogPath, "tidy": r.Tidy, "fellBack": r.FellBack})
			if !r.OK {
				failed = append(failed, r.Host)
			}
		}
		if len(failed) > 0 {
			return fmt.Errorf("deploy failed on %s", strings.Join(failed, ", "))
		}
		return nil
	}
	if adHoc {
		return printReceipt(results[0])
	}
	return printDeployResults(results)
}

// lineOut prints whole lines from the deploy's goroutines one at a time.
type lineOut struct {
	mu sync.Mutex
	// w is where lines go; stdout when nil.
	w io.Writer
}

func (o *lineOut) out() io.Writer {
	if o.w != nil {
		return o.w
	}
	return os.Stdout
}

// emit prints v as JSON on one line: a program reading the events takes one
// object per line.
func (o *lineOut) emit(v any) {
	data, err := json.Marshal(v)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "fleet", "event could not be encoded", map[string]any{"error": err.Error()})
		return
	}
	o.mu.Lock()
	defer o.mu.Unlock()
	fmt.Fprintln(o.out(), string(data)) //nolint:errcheck // stdout
}

func (o *lineOut) printf(format string, args ...any) {
	o.mu.Lock()
	defer o.mu.Unlock()
	fmt.Fprintf(o.out(), format, args...) //nolint:errcheck // stdout
}

// planEvent is a prepared deploy for a program: the plan as lines a person
// reads, and each host and each build as data, with what stops the ones that
// cannot go ahead.
func planEvent(p *fleet.Prepared, runID string, allowDowngrade bool) map[string]any {
	targets := make([]map[string]any, 0, len(p.Targets))
	for _, t := range p.Targets {
		row := map[string]any{"host": t.Host.Name, "label": t.Host.Name, "component": t.Component, "goos": t.GOOS, "goarch": t.GOARCH, "self": t.Self, "source": t.Source, "refusal": t.Refusal}
		if t.Host.Label != "" {
			row["label"] = t.Host.Label
		}
		if t.Host.Entry != nil {
			row["environmentId"] = t.Host.Entry.EnvironmentID
		}
		targets = append(targets, row)
	}
	builds := make([]map[string]any, 0, len(p.Builds))
	for _, b := range p.Builds {
		builder := ""
		if b.Builder != nil {
			builder = b.Builder.Name
		}
		candidates := b.Candidates
		if candidates == nil {
			candidates = []fleet.BuilderCheck{}
		}
		builds = append(builds, map[string]any{"key": b.Key, "component": b.Component, "goos": b.GOOS, "goarch": b.GOARCH, "builder": builder, "hosts": b.Hosts, "refusal": b.Refusal, "candidates": candidates})
	}
	return map[string]any{"event": "plan", "runId": runID, "lines": p.PlanLines(), "targets": targets, "builds": builds, "blocked": p.Preflight.Blocks() && !allowDowngrade}
}

// deployArgs are the arguments after `ion fleet deploy`.
func deployArgs() []string {
	for i, a := range os.Args {
		if a == "deploy" && i > 0 && os.Args[i-1] == "fleet" {
			return os.Args[i+1:]
		}
	}
	return nil
}

// adHocHost is the --to host: the fleet's entry for that ssh target when it
// has one, else a host of the given kind added to the fleet for this deploy
// only, so the plan compares it with the rest. A host an earlier fleet file
// listed and that has not moved into the server list yet keeps the settings
// that file gave it: a host with no Ion on it cannot move until this very
// deploy installs one. buildDir, when given, is where the host builds.
func adHocHost(cfg fleet.Config, target, kind string, askSudo bool, buildDir string) (fleet.Config, fleet.Host, error) {
	known := func(h fleet.Host) (fleet.Host, error) {
		if kind != "" && h.Kind != "" && kind != h.Kind {
			return h, fmt.Errorf("%s is a %s host in the fleet", target, h.Kind)
		}
		if h.Kind == "" {
			h.Kind = kind
		}
		h.AskSudo = h.AskSudo || askSudo
		if buildDir != "" {
			h.BuildDir = buildDir
		}
		return h, nil
	}
	for _, h := range cfg.Hosts {
		if h.SSH == target {
			h, err := known(h)
			return cfg, h, err
		}
	}
	for _, legacy := range cfg.LegacyHosts {
		if legacy.SSH != target {
			continue
		}
		h, err := known(legacy)
		if err != nil {
			return cfg, h, err
		}
		cfg.Hosts = append(append([]fleet.Host{}, cfg.Hosts...), h)
		return cfg, h, nil
	}
	if kind != fleet.KindDesktop && kind != fleet.KindServer {
		return cfg, fleet.Host{}, errors.New("--to needs --kind desktop or --kind server")
	}
	h := fleet.Host{Name: target, SSH: target, Kind: kind, AskSudo: askSudo, BuildDir: buildDir}
	cfg.Hosts = append(append([]fleet.Host{}, cfg.Hosts...), h)
	return cfg, h, nil
}

func absPath(p string) string {
	if p == "" {
		return ""
	}
	if abs, err := filepath.Abs(p); err == nil {
		return abs
	}
	return p
}

// printReceipt ends a --to deploy with its JSON receipt, the line a script
// reads.
func printReceipt(r fleet.Result) error {
	rec := r.Receipt
	if rec == nil {
		rec = &fleet.Receipt{Host: r.Host}
	}
	data, err := json.Marshal(rec)
	if err != nil {
		return err
	}
	fmt.Println(string(data))
	if !r.OK {
		return fmt.Errorf("%s (log: %s)", r.Error, r.LogPath)
	}
	return nil
}

func flagValue(flags map[string]string, key string) string {
	if v := flags[key]; v != "true" {
		return v
	}
	return ""
}

func printDeployResults(results []fleet.Result) error {
	fmt.Println()
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "HOST\tRESULT\tNOW\tLOG") //nolint:errcheck // tabwriter buffers; Flush reports
	var failed []string
	for _, r := range results {
		outcome := "deployed"
		if !r.OK {
			outcome = "FAILED: " + r.Error
			failed = append(failed, r.Host)
		}
		now := "-"
		if r.After != nil && r.After.Report != nil {
			now = fleet.ServerCell(r.After.Report)
			if r.After.Report.Components.Desktop != nil {
				now = "desktop " + r.After.Report.Components.Desktop.Version
			}
		}
		fmt.Fprintf(tw, "%s\t%s\t%s\t%s\n", r.Host, outcome, now, r.LogPath) //nolint:errcheck // tabwriter buffers; Flush reports
	}
	tw.Flush() //nolint:errcheck // stdout
	for _, r := range results {
		for _, note := range []string{r.FellBack, r.Tidy} {
			if note != "" {
				fmt.Printf("%s: %s\n", r.Host, note)
			}
		}
	}
	if len(failed) > 0 {
		return fmt.Errorf("deploy failed on %s", strings.Join(failed, ", "))
	}
	return nil
}

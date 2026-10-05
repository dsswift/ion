package fleet

import (
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/studiostatus"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Components a deploy installs.
const (
	ComponentServer  = "server"  // the Studio Server bundle (engine + server + node)
	ComponentDesktop = "desktop" // the Ion desktop app (carries its own server and engine)
)

// Sources a deploy installs from.
const (
	SourceDev     = "dev"     // a build of the fleet file's checkout
	SourceRelease = "release" // the newest published release
)

// Target is one host and what it gets.
type Target struct {
	Host      Host   `json:"host"`
	Component string `json:"component"`
	// Platform is the host's goos/goarch, which picks a server bundle.
	GOOS   string `json:"goos"`
	GOARCH string `json:"goarch"`
	// Self: the host installs on itself, told over its Studio connection.
	// Otherwise the fleet installs on it over SSH.
	Self bool `json:"self,omitempty"`
	// Source is what this host installs: the request's source, or release
	// for a host the request names in ReleaseHosts.
	Source string `json:"source,omitempty"`
	// Refusal is why this host cannot be deployed; the deploy goes on
	// without it and reports it failed.
	Refusal string `json:"refusal,omitempty"`
	// fallback: this SSH install follows a failed self-install. That one
	// already quit Ion on the host, so this one may quit it too.
	fallback bool
}

// Request is what the operator asked for.
type Request struct {
	Hosts []Host
	// Component is server or desktop; empty means each host's own kind.
	Component string
	// Source is dev or release (ResolveSource turns a path into dev).
	Source string
	// Checkout is the Ion checkout a dev deploy builds from, and whose
	// Studio Server installer a server install runs; ResolveSource picks it.
	Checkout       string
	AllowDowngrade bool
	// Install is what every install does; each host adds its own sudo
	// setting and its profile's relay and arguments.
	Install InstallOptions
	// Artifact installs this desktop package or installer instead of a build.
	Artifact string
	// NoBuild installs the newest build already in the checkout.
	NoBuild bool
	// Terminal says this process has a terminal a host's sudo can ask on.
	Terminal bool
	// Known are host statuses the caller already read. Prepare reads only
	// the fleet's hosts missing from it.
	Known []HostStatus
	// ForceSSH installs over SSH even on a host that would install on itself.
	ForceSSH bool
	// ReleaseHosts are hosts, by name, that install the newest release even
	// though the request builds a checkout: the way out for a host nothing
	// can build for.
	ReleaseHosts []string
}

// ExecSpec is one local command a deploy runs (a build or a deploy script).
type ExecSpec struct {
	Dir  string
	Name string
	Args []string
	// Env is added to this process's environment.
	Env []string
	// Interactive commands need this terminal (a sudo password prompt).
	Interactive bool
	// Banner says what an interactive command will ask for. A view that
	// hides the terminal prints it when it hands the terminal over; a plain
	// terminal already showed it in the echoed log.
	Banner string
	Stdout io.Writer
	Stderr io.Writer
}

// Event is one step of a deploy, for a live view.
type Event struct {
	Host  string `json:"host"`
	Stage string `json:"stage"`
	// Detail is the stage's one-line explanation, or the failure.
	Detail string `json:"detail,omitempty"`
}

// Stages a target moves through.
const (
	StageQueued    = "queued"
	StageBuilding  = "building"
	StageDeploying = "deploying"
	StageWaiting   = "waiting for the terminal"
	StageVerifying = "verifying"
	StageDone      = "done"
	StageFailed    = "failed"
)

// Deployer plans and runs deploys.
type Deployer struct {
	Config    Config
	Runner    Runner
	Collector Collector
	// OpenLink opens a host's Studio connection for a self-install; nil
	// deploys every host over SSH.
	OpenLink LinkOpener
	// Exec runs a local command; ExecLocal by default.
	Exec func(ctx context.Context, spec ExecSpec) error
	// Latest reads the newest releases; LatestReleases by default.
	Latest func(ctx context.Context) (Latest, error)
	// Artifacts builds and downloads what a deploy installs.
	Artifacts Artifacts
	// LogDir holds one log per host per deploy.
	LogDir   string
	Progress func(Event)
	// Echo also receives every build and install log line, prefixed with
	// its host, for a deploy watched on a terminal.
	Echo io.Writer
	// LogLine also receives every build and install log line with the hosts
	// it is about, for a view that shows each host's log as it grows.
	LogLine func(hosts []string, line string)
	// RunID names this deploy to the hosts it tells about it.
	RunID string

	// The checkout shipped to builder hosts, packed once per deploy.
	archiveOnce  sync.Once
	archiveStamp checkoutStamp
	archivePath  string
	archiveErr   error
}

// resetArchive forgets (and removes) the last deploy's checkout archive.
func (d *Deployer) resetArchive() {
	if d.archivePath != "" {
		if err := os.Remove(d.archivePath); err != nil && !os.IsNotExist(err) {
			utils.LogWithFields(utils.LevelWarn, logTag, "could not remove the checkout archive", map[string]any{"path": d.archivePath, "error": err.Error()})
		}
	}
	d.archiveOnce, d.archiveStamp, d.archivePath, d.archiveErr = sync.Once{}, checkoutStamp{}, "", nil
}

// Prepared is a deploy ready to run: its targets, the fleet's statuses now,
// the new builds' formats, and what they change.
type Prepared struct {
	Request   Request
	Targets   []Target
	Statuses  []HostStatus
	Formats   map[string][]compat.Format
	Preflight Preflight
	Latest    Latest
	// Builds are where a dev deploy builds each artifact.
	Builds []BuildPlan
}

// Prepare resolves the targets and computes the preflight. It builds nothing
// the operator has not agreed to: a dev preflight reads the checkout's
// registries, a release preflight reads the published artifacts. A host that
// cannot be deployed is a target with a Refusal, never an error: the rest of
// the deploy does not wait on it.
func (d *Deployer) Prepare(ctx context.Context, req Request) (*Prepared, error) {
	if req.Source != SourceDev && req.Source != SourceRelease {
		return nil, fmt.Errorf("source must be %q or %q", SourceDev, SourceRelease)
	}
	if len(req.Hosts) == 0 {
		return nil, errors.New("name at least one host")
	}
	if req.Source == SourceDev && req.Checkout == "" && req.Artifact == "" {
		return nil, errors.New("a dev deploy builds from a checkout: name it with `ion fleet checkout PATH`, or pass --source PATH (--source . builds this folder)")
	}
	p := &Prepared{Request: req, Formats: map[string][]compat.Format{}}
	var read []string
	p.Statuses, read = d.statuses(ctx, req.Known)
	wantsRelease := req.Source == SourceRelease
	for _, h := range req.Hosts {
		t, err := d.target(ctx, p, h)
		if err != nil {
			t.Refusal = err.Error()
			utils.LogWithFields(utils.LevelWarn, logTag, "host cannot be deployed", map[string]any{"fleet_host": h.Name, "reason": t.Refusal})
		}
		wantsRelease = wantsRelease || (t.Refusal == "" && t.Source == SourceRelease)
		p.Targets = append(p.Targets, t)
	}
	d.planBuilds(ctx, p)
	latest := d.Latest
	if latest == nil {
		latest = LatestReleases
	}
	if wantsRelease {
		var err error
		if p.Latest, err = latest(ctx); err != nil {
			return nil, err
		}
	}
	for i, t := range p.Targets {
		if t.Refusal != "" {
			continue
		}
		formats, err := d.Artifacts.TargetFormats(ctx, req.Checkout, t.Source, t, p.Latest)
		if err != nil {
			if t.Source == SourceRelease && errors.Is(err, errNoRelease) {
				p.Targets[i].Refusal = err.Error()
				continue
			}
			utils.LogWithFields(utils.LevelWarn, logTag, "deploy preflight: new build's formats unreadable", map[string]any{"fleet_host": t.Host.Name, "error": err.Error()})
		}
		p.Formats[t.Host.Name] = formats
	}
	p.Preflight = ComputePreflight(p.Statuses, p.Formats)
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy prepared", map[string]any{
		"source": req.Source, "targets": targetNames(p.Targets), "refused": len(p.Refused()), "changes": len(p.Preflight.Changes), "downgrades": len(p.Preflight.Downgrades), "unknown": p.Preflight.Unknown,
		"unreadable": len(p.Preflight.Unreadable), "read_hosts": read, "known_hosts": len(p.Statuses) - len(read),
	})
	return p, nil
}

// target is how one host is deployed: the component it takes, its platform,
// and whether it installs on itself. A host that answers on its Studio
// connection installs on itself, unless it runs Windows (whose installer
// needs an administrator) or the request forces SSH; any other host needs
// an SSH target. An error says why the host cannot be deployed; the target
// returned with it holds what was learned before it.
func (d *Deployer) target(ctx context.Context, p *Prepared, h Host) (Target, error) {
	t := Target{Host: h, Source: p.Request.Source}
	for _, name := range p.Request.ReleaseHosts {
		if name == h.Name {
			t.Source = SourceRelease
		}
	}
	var report *studiostatus.Report
	for _, st := range p.Statuses {
		if st.Host.Name == h.Name {
			report = st.Report
		}
	}
	kind := h.Kind
	if kind == "" {
		var ok bool
		if kind, ok = KindOfReport(report); !ok {
			return t, errKindUnknown(h)
		}
	}
	component := p.Request.Component
	if component == "" {
		component = kind
	}
	t.Component = component
	if component != kind {
		return t, fmt.Errorf("%s is a %s host; it takes the %s component", h.Name, kind, kind)
	}
	h.Kind = kind
	t.Host = h
	switch {
	case h.SSH != "":
		plat, err := d.Runner.Platform(ctx, h)
		if err != nil {
			return t, fmt.Errorf("%s: %w", h.Name, err)
		}
		t.GOOS, t.GOARCH = plat.GOOS, plat.GOARCH
	case report != nil && report.Platform != "":
		t.GOOS, t.GOARCH = platformFromReport(report.Platform, report.Arch)
	default:
		return t, fmt.Errorf("%s does not answer, and it has no SSH target to deploy over", h.Name)
	}
	if t.GOOS == "windows" && component == ComponentServer {
		return t, fmt.Errorf("%s runs Windows, which has no Studio Server bundle; it takes the desktop", h.Name)
	}
	if d.OpenLink != nil && !p.Request.ForceSSH && h.Paired() && t.GOOS != "windows" {
		if link, err := d.OpenLink(ctx, h); err == nil {
			can, why := canInstallItself(ctx, link)
			link.Close()
			t.Self = can
			if !can {
				utils.LogWithFields(utils.LevelInfo, logTag, "host cannot install on itself; deploying over ssh", map[string]any{"fleet_host": h.Name, "reason": why})
			}
		} else {
			utils.LogWithFields(utils.LevelInfo, logTag, "host does not answer on its studio connection; deploying over ssh", map[string]any{"fleet_host": h.Name, "error": err.Error()})
		}
	}
	if !t.Self && h.SSH == "" {
		if t.GOOS == "windows" {
			return t, fmt.Errorf("%s runs Windows, whose installer needs an administrator; name its SSH target with `ion fleet set %s --ssh [user@]host`", h.Name, h.Name)
		}
		return t, h.ErrExternal()
	}
	return t, nil
}

// statuses is every fleet host's status, in fleet order: the known ones as
// given, the rest read now. It also returns the names it read.
func (d *Deployer) statuses(ctx context.Context, known []HostStatus) ([]HostStatus, []string) {
	byName := make(map[string]HostStatus, len(known))
	for _, st := range known {
		byName[st.Host.Name] = st
	}
	var missing []Host
	for _, h := range d.Config.Hosts {
		if _, ok := byName[h.Name]; !ok {
			missing = append(missing, h)
		}
	}
	read := make([]string, 0, len(missing))
	for _, st := range d.Collector.Collect(ctx, missing) {
		byName[st.Host.Name] = st
		read = append(read, st.Host.Name)
	}
	out := make([]HostStatus, 0, len(d.Config.Hosts))
	for _, h := range d.Config.Hosts {
		out = append(out, byName[h.Name])
	}
	return out, read
}

func targetNames(ts []Target) []string {
	out := make([]string, 0, len(ts))
	for _, t := range ts {
		out = append(out, t.Host.Name)
	}
	sort.Strings(out)
	return out
}

// sourceOf is what a target installs: its own source, else the request's.
func (p *Prepared) sourceOf(t Target) string {
	if t.Source != "" {
		return t.Source
	}
	return p.Request.Source
}

// Refused are the targets that cannot be deployed.
func (p *Prepared) Refused() []Target {
	var out []Target
	for _, t := range p.Targets {
		if t.Refusal != "" {
			out = append(out, t)
		}
	}
	return out
}

// PlanLines describes the deploy before it runs.
func (p *Prepared) PlanLines() []string {
	source := p.Request.Source
	if p.Request.Source == SourceDev {
		source = "dev build of " + p.Request.Checkout
	}
	out := []string{"Deploying the " + source + ":"}
	for _, t := range p.Targets {
		if t.Refusal != "" {
			continue
		}
		note := ""
		switch {
		case t.Component != ComponentDesktop:
		case p.Request.Install.QuitIon:
			note = " (Ion there quits: its running conversations stop)"
		default:
			note = " (stops if Ion is running there; --quit-ion quits it)"
		}
		if t.Self {
			note = " (the host installs it on itself"
			if t.Component == ComponentDesktop {
				note += "; Ion there restarts, and its running conversations stop"
			}
			note += ")"
		} else if t.Host.AskSudo && t.GOOS == "darwin" {
			note += " (asks for its sudo password on this terminal, after the others)"
		}
		if p.sourceOf(t) != p.Request.Source {
			note += " (installs the newest release, not the build)"
		}
		out = append(out, fmt.Sprintf("  %s: %s %s/%s%s", t.Host.Name, t.Component, t.GOOS, t.GOARCH, note))
	}
	var builds []string
	for _, b := range p.Builds {
		if b.Refusal == "" {
			builds = append(builds, b.Line())
		}
	}
	if len(builds) > 0 && !p.Request.NoBuild {
		out = append(append(out, "Builds:"), builds...)
	}
	out = append(out, p.refusalLines()...)
	return append(out, p.Preflight.Lines()...)
}

// refusalLines name each host that cannot be deployed, one line each, and
// under an artifact nothing can build, what stops each machine and the
// command that fixes it.
func (p *Prepared) refusalLines() []string {
	refused := p.Refused()
	if len(refused) == 0 {
		return nil
	}
	out := []string{"Not deployed:"}
	unbuildable := map[string]bool{}
	for _, t := range refused {
		b, ok := p.buildFor(artifactKey(t))
		if !ok || b.Refusal == "" || b.Refusal != t.Refusal {
			out = append(out, fmt.Sprintf("  %s: %s", t.Host.Name, t.Refusal))
			continue
		}
		if unbuildable[b.Key] {
			continue
		}
		unbuildable[b.Key] = true
		out = append(out, fmt.Sprintf("  %s: nothing can build the %s", strings.Join(b.Hosts, ", "), b.what()))
		for _, c := range b.Candidates {
			for _, problem := range c.Problems {
				line := "    " + problem.Message
				if remedy := problem.Remedy(c.Host); remedy != "" {
					line += " (" + remedy + ")"
				}
				out = append(out, line)
			}
		}
		out = append(out, fmt.Sprintf("    or install the newest release there: --release-for %s", strings.Join(b.Hosts, ",")))
	}
	return out
}

// logPath is this deploy's log for one host.
func (d *Deployer) logPath(name, stamp string) string {
	return filepath.Join(d.LogDir, name+"-"+stamp+".log")
}

func (d *Deployer) emit(host, stage, detail string) {
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy stage", map[string]any{"fleet_host": host, "stage": stage, "detail": detail})
	if d.Progress != nil {
		d.Progress(Event{Host: host, Stage: stage, Detail: detail})
	}
}

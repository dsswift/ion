package fleet

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Result is one target's outcome.
type Result struct {
	Host    string   `json:"host"`
	OK      bool     `json:"ok"`
	Error   string   `json:"error,omitempty"`
	LogPath string   `json:"logPath"`
	Receipt *Receipt `json:"receipt,omitempty"`
	// After is the host's status read once the deploy finished.
	After *HostStatus `json:"after,omitempty"`
}

// artifact is one built or downloaded installable: a desktop package or
// installer, or a server bundle.
type artifact struct {
	path string
	// archs are a Mac package's CPUs, when known.
	archs string
	err   error
}

// artifactKey names what a target installs: its component on its platform.
func artifactKey(t Target) string {
	return t.Component + "/" + t.GOOS + "/" + t.GOARCH
}

// Run builds once per platform, deploys the hosts that need no terminal in
// parallel, then the ones whose sudo asks for a password, one at a time, and
// reads every target's status again. One host failing never stops another.
func (d *Deployer) Run(ctx context.Context, p *Prepared) ([]Result, error) {
	if p.Preflight.Blocks() && !p.Request.AllowDowngrade {
		return nil, errors.New("this deploy lowers a stored-data format on a host; rerun with --allow-downgrade to go ahead")
	}
	if err := os.MkdirAll(d.LogDir, 0o700); err != nil {
		return nil, err
	}
	stamp := time.Now().Format("20060102-150405")
	d.resetArchive()
	defer d.resetArchive()
	for _, t := range p.Targets {
		d.emit(t.Host.Name, StageQueued, "")
	}
	keys, keyErrs := d.relayKeys(ctx, p.Targets)
	arts := d.prepareArtifacts(ctx, p, stamp)

	results := make([]Result, len(p.Targets))
	var wg sync.WaitGroup
	sem := make(chan struct{}, d.Config.ConcurrencyOrDefault())
	var interactive []int
	for i, t := range p.Targets {
		if t.Host.AskSudo && t.Component == ComponentDesktop && t.GOOS == "darwin" {
			interactive = append(interactive, i)
			d.emit(t.Host.Name, StageWaiting, "runs after the others, on this terminal")
			continue
		}
		wg.Add(1)
		go func(i int, t Target) {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			results[i] = d.deployOne(ctx, p, t, arts, keys, keyErrs, stamp, false)
		}(i, t)
	}
	wg.Wait()
	for _, i := range interactive {
		results[i] = d.deployOne(ctx, p, p.Targets[i], arts, keys, keyErrs, stamp, true)
	}

	var hosts []Host
	for _, t := range p.Targets {
		hosts = append(hosts, t.Host)
	}
	after := d.Collector.Collect(ctx, hosts)
	for i := range results {
		st := after[i]
		results[i].After = &st
	}
	return results, nil
}

// relayKeys runs each profile's key command once for this deploy. The keys
// live in memory only, for the child processes that need them.
func (d *Deployer) relayKeys(ctx context.Context, targets []Target) (map[string]string, map[string]error) {
	keys, errs := map[string]string{}, map[string]error{}
	for _, t := range targets {
		name := t.Host.Profile
		p := d.Config.ProfileOf(t.Host)
		if p.RelayKeyCommand == "" || keys[name] != "" || errs[name] != nil {
			continue
		}
		key, err := RelayKey(ctx, p)
		if err != nil {
			errs[name] = err
			continue
		}
		keys[name] = key
	}
	return keys, errs
}

// prepareArtifacts builds (dev) or downloads (release) what the targets
// need, once per artifact. Builds on hosts run at once; builds on this
// machine run one after another, since they share the checkout.
func (d *Deployer) prepareArtifacts(ctx context.Context, p *Prepared, stamp string) map[string]artifact {
	arts := map[string]artifact{}
	var mu sync.Mutex
	var wg sync.WaitGroup
	set := func(key string, a artifact) {
		if a.err != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "deploy artifact unavailable", map[string]any{"artifact": key, "error": a.err.Error()})
		}
		mu.Lock()
		arts[key] = a
		mu.Unlock()
	}
	seen := map[string]bool{}
	for _, t := range p.Targets {
		key := artifactKey(t)
		if seen[key] || (t.Component == ComponentServer && p.Request.Source == SourceRelease) {
			continue // the host updates itself
		}
		seen[key] = true
		if b, ok := p.buildFor(key); ok && b.Builder != nil && !p.Request.NoBuild {
			wg.Add(1)
			go func(key string, b BuildPlan) {
				defer wg.Done()
				d.emitFor(p.Targets, key, StageBuilding, "building on "+b.Builder.Name)
				report := func(detail string) { d.emitFor(p.Targets, key, StageBuilding, detail) }
				var a artifact
				a.err = d.withLog("build-"+strings.ReplaceAll(key, "/", "-")+"-on-"+b.Builder.Name, stamp, report, func(log io.Writer) error {
					var err error
					a, err = d.buildOnHost(ctx, b, p.Request.Checkout, log, report)
					return err
				})
				set(key, a)
			}(key, b)
			continue
		}
		set(key, d.artifactFor(ctx, p, t, key, stamp))
	}
	wg.Wait()
	return arts
}

func (d *Deployer) artifactFor(ctx context.Context, p *Prepared, t Target, key, stamp string) artifact {
	req := p.Request
	given := req.Artifact
	report := func(detail string) { d.emitFor(p.Targets, key, StageBuilding, detail) }
	switch {
	case given != "":
		if t.Component == ComponentServer {
			return artifact{err: errors.New("--pkg installs a desktop; a server builds from the checkout")}
		}
		if (t.GOOS == "windows") != strings.HasSuffix(strings.ToLower(given), ".exe") {
			return artifact{err: fmt.Errorf("%s does not install on %s", filepath.Base(given), t.GOOS)}
		}
		return artifact{path: given, archs: d.Artifacts.PackageArchs(req.Checkout, given)}
	case req.Source == SourceRelease && t.GOOS == "windows":
		d.emitFor(p.Targets, key, StageBuilding, "downloading desktop "+p.Latest.Desktop+" for Windows "+t.GOARCH)
		path, err := d.Artifacts.DesktopReleaseSetup(ctx, p.Latest, t.GOARCH)
		return artifact{path: path, err: err}
	case req.Source == SourceRelease:
		d.emitFor(p.Targets, key, StageBuilding, "downloading desktop "+p.Latest.Desktop)
		path, err := d.Artifacts.DesktopReleasePkg(ctx, p.Latest)
		return artifact{path: path, err: err}
	case req.NoBuild:
		return d.Artifacts.existingBuild(req.Checkout, t, key)
	case t.Component == ComponentServer:
		d.emitFor(p.Targets, key, StageBuilding, "packaging the Studio Server bundle for "+t.GOOS+"/"+t.GOARCH)
		if err := d.withLog("build-server-"+t.GOOS+"-"+t.GOARCH, stamp, report, func(log io.Writer) error {
			return d.Artifacts.BuildServer(ctx, req.Checkout, t.GOOS, t.GOARCH, log)
		}); err != nil {
			return artifact{err: fmt.Errorf("the %s/%s bundle did not build: %w", t.GOOS, t.GOARCH, err)}
		}
		return d.Artifacts.existingBuild(req.Checkout, t, key)
	case t.GOOS == "windows":
		d.emitFor(p.Targets, key, StageBuilding, "building the Windows desktop installer (make.ps1 installer)")
		var exe string
		err := d.withLog("build-desktop-windows-"+t.GOARCH, stamp, report, func(log io.Writer) error {
			var buildErr error
			exe, buildErr = d.Artifacts.BuildWindowsDesktop(ctx, req.Checkout, t.GOARCH, log)
			return buildErr
		})
		return artifact{path: exe, err: err}
	default:
		d.emitFor(p.Targets, key, StageBuilding, "building the desktop installer (make desktop-pkg)")
		var pkg string
		err := d.withLog("build-desktop", stamp, report, func(log io.Writer) error {
			var buildErr error
			pkg, buildErr = d.Artifacts.BuildDesktop(ctx, req.Checkout, log)
			return buildErr
		})
		return artifact{path: pkg, archs: d.Artifacts.PackageArchs(req.Checkout, pkg), err: err}
	}
}

func (d *Deployer) emitFor(targets []Target, key, stage, detail string) {
	for _, t := range targets {
		if artifactKey(t) == key {
			d.emit(t.Host.Name, stage, detail)
		}
	}
}

// withLog runs fn with a log file for a build step. Every line of the log
// carries the time and the time since the step began, and report hears a
// heartbeat while the step runs, so a slow build and a hung one look
// different.
func (d *Deployer) withLog(name, stamp string, report func(detail string), fn func(io.Writer) error) error {
	f, err := os.OpenFile(d.logPath(name, stamp), os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck // log file; the step's own error is the one reported
	sw := newStampWriter(d.echoed(f, name))
	defer heartbeat(name, "", sw, true, report)()
	started := time.Now()
	err = fn(sw)
	fields := map[string]any{"step": name, "seconds": int(time.Since(started).Seconds()), "ok": err == nil}
	if err != nil {
		fields["error"] = err.Error()
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "deploy build step finished", fields)
	if err != nil {
		sw.note(fmt.Sprintf("failed after %s: %v", formatElapsed(time.Since(started)), err))
	} else {
		sw.note("finished in " + formatElapsed(time.Since(started)))
	}
	return err
}

// echoed copies a log to Echo too, each line prefixed with its source.
func (d *Deployer) echoed(log io.Writer, source string) io.Writer {
	if d.Echo == nil {
		return log
	}
	return io.MultiWriter(log, &prefixWriter{w: d.Echo, prefix: source + ": "})
}

// prefixWriter writes whole lines, each with a prefix.
type prefixWriter struct {
	mu      sync.Mutex
	w       io.Writer
	prefix  string
	partial []byte
}

func (p *prefixWriter) Write(b []byte) (int, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.partial = append(p.partial, b...)
	for {
		i := bytes.IndexByte(p.partial, '\n')
		if i < 0 {
			return len(b), nil
		}
		if _, err := fmt.Fprintf(p.w, "%s%s\n", p.prefix, p.partial[:i]); err != nil {
			return len(b), err
		}
		p.partial = p.partial[i+1:]
	}
}

func (d *Deployer) deployOne(ctx context.Context, p *Prepared, t Target, arts map[string]artifact, keys map[string]string, keyErrs map[string]error, stamp string, interactive bool) Result {
	h := t.Host
	res := Result{Host: h.Name, LogPath: d.logPath(h.Name, stamp)}
	fail := func(err error) Result {
		res.Error = err.Error()
		d.emit(h.Name, StageFailed, res.Error)
		return res
	}
	logFile, err := os.OpenFile(res.LogPath, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return fail(err)
	}
	defer logFile.Close() //nolint:errcheck // log file; the deploy's own error is the one reported
	d.emit(h.Name, StageDeploying, "")
	started := time.Now()
	sw := newStampWriter(d.echoed(logFile, h.Name))
	var step atomic.Value
	stopBeat := heartbeat("deploy to "+h.Name, h.Name, nil, false, func(string) {
		cur, ok := step.Load().(string)
		if !ok {
			cur = "starting"
		}
		d.emit(h.Name, StageDeploying, fmt.Sprintf("%s (%s)", cur, formatElapsed(time.Since(started))))
	})
	defer stopBeat()
	defer func() {
		fields := map[string]any{"fleet_host": h.Name, "seconds": int(time.Since(started).Seconds()), "ok": res.OK}
		if res.Error != "" {
			fields["error"] = res.Error
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "deploy host finished", fields)
		sw.note(fmt.Sprintf("deploy to %s took %s", h.Name, formatElapsed(time.Since(started))))
	}()

	if t.Component == ComponentServer && p.Request.Source == SourceRelease {
		out, err := runIon(ctx, d.Runner, h, []string{"studio", "update", "--yes"}, nil)
		logFile.Write(out) //nolint:errcheck // log copy of the host's output
		if err != nil {
			return fail(fmt.Errorf("ion studio update: %w", err))
		}
		res.OK = true
		d.emit(h.Name, StageDone, "updated to "+p.Latest.Server)
		return res
	}
	w := io.Writer(sw)
	art := arts[artifactKey(t)]
	if art.err != nil {
		return fail(art.err)
	}
	opts, err := d.installOptions(p, t, keys, keyErrs, interactive)
	if err != nil {
		return fail(err)
	}
	opts.OnStep = func(s string) {
		step.Store(s)
		d.emit(h.Name, StageDeploying, s)
	}
	r := terminalRunner{Runner: d.Runner, exec: d.exec}
	var rec Receipt
	switch {
	case t.Component == ComponentServer:
		installer, readErr := os.ReadFile(filepath.Join(p.Request.Checkout, "scripts", "install-studio-server.sh"))
		if readErr != nil {
			return fail(fmt.Errorf("read the checkout's installer: %w", readErr))
		}
		rec, err = InstallServer(ctx, r, h, art.path, installer, opts, w)
	case t.GOOS == "windows":
		rec, err = InstallWindowsDesktop(ctx, r, h, art.path, opts, w)
	default:
		rec, err = InstallMacDesktop(ctx, r, h, art.path, art.archs, opts, w)
	}
	res.Receipt = &rec
	if err != nil {
		return fail(fmt.Errorf("%w; see %s", err, res.LogPath))
	}
	res.OK = true
	d.emit(h.Name, StageDone, rec.Version)
	return res
}

// installOptions are the request's install options for one target, with its
// host's sudo setting and its profile's relay and arguments.
func (d *Deployer) installOptions(p *Prepared, t Target, keys map[string]string, keyErrs map[string]error, interactive bool) (InstallOptions, error) {
	h := t.Host
	o := p.Request.Install
	o.AskSudo = o.AskSudo || h.AskSudo
	o.Interactive = interactive && p.Request.Terminal
	if o.SudoHint == "" {
		o.SudoHint = fmt.Sprintf(`set "askSudo": true on host %q in %s to be asked for the password on this terminal`, h.Name, DefaultPath())
	}
	prof := d.Config.ProfileOf(h)
	if len(prof.Args) > 0 {
		extra, rest, err := ParseInstallArgs(prof.Args, o)
		if err != nil {
			return o, fmt.Errorf("profile %q args: %w", h.Profile, err)
		}
		if len(rest) > 0 {
			return o, fmt.Errorf("profile %q args: unknown %v", h.Profile, rest)
		}
		o = extra
	}
	if o.Relay == "" && prof.Relay != "" {
		o.Relay, o.RelayOIDC = prof.Relay, prof.RelayOIDC
		if !prof.RelayOIDC {
			if keyErrs[h.Profile] != nil {
				return o, keyErrs[h.Profile]
			}
			o.RelayKey = keys[h.Profile]
		}
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "install options", map[string]any{
		"fleet_host": h.Name, "quit_ion": o.QuitIon, "ask_sudo": o.AskSudo, "interactive": o.Interactive, "backup": o.Backup,
		"open": o.Open, "pair": o.Pair != "", "relay": o.Relay, "relay_oidc": o.RelayOIDC, "relay_key": o.RelayKey != "",
	})
	return o, nil
}

// terminalRunner sends a run that needs this terminal through the deployer's
// Exec, so a dashboard can hand the terminal over for it.
type terminalRunner struct {
	Runner
	exec func(ctx context.Context, spec ExecSpec) error
}

func (r terminalRunner) RunTerminal(ctx context.Context, h Host, script, banner string, out io.Writer) error {
	spec := terminalCommand(h, script)
	spec.Stdout, spec.Stderr, spec.Banner = out, out, banner
	return r.exec(ctx, spec)
}

func (d *Deployer) exec(ctx context.Context, spec ExecSpec) error {
	if d.Exec != nil {
		return d.Exec(ctx, spec)
	}
	return ExecLocal(ctx, spec)
}

// lastReceipt finds the last JSON object an installer printed.
func lastReceipt(out []byte) map[string]any {
	lines := strings.Split(strings.TrimSpace(string(out)), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		start := strings.Index(lines[i], "{")
		if start < 0 {
			continue
		}
		var m map[string]any
		if json.Unmarshal([]byte(lines[i][start:]), &m) == nil {
			return m
		}
	}
	return nil
}

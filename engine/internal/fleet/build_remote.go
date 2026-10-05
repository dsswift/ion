package fleet

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// buildRoots are the parts of a checkout a build reads: what ships to a
// builder host. The repository root's build files are named one by one.
var buildRoots = []string{"engine", "server", "packages", "sdk", "desktop", "scripts", "packaging", ".husky",
	"Makefile", "make.ps1", "bootstrap.ps1", "release-please-manifest.json", "release-please-config.json", "package.json", "package-lock.json", ".npmrc"}

// defaultBuildDir is a builder host's build folder unless the fleet file
// names another (Host.BuildDir), under its home. Its node_modules folders
// survive from one build to the next; everything else is replaced by the
// shipped checkout.
const defaultBuildDir = ".ion/fleet-build/ion"

// posixBuildDir is a build folder as a POSIX shell word.
func posixBuildDir(dir string) string {
	if strings.HasPrefix(dir, "/") {
		return shellQuote(dir)
	}
	return `"$HOME/"` + shellQuote(dir)
}

// psBuildDir is a build folder as a PowerShell expression.
func psBuildDir(dir string) string {
	win := strings.ReplaceAll(dir, "/", `\`)
	if len(win) > 1 && win[1] == ':' {
		return psQuote(win)
	}
	return "(Join-Path $env:USERPROFILE " + psQuote(win) + ")"
}

// checkoutStamp says what a shipped checkout is, since it arrives with no git
// history: the same .ion-sync-stamp.json a Windows build reads for its
// versions, plus the versions a Mac or Linux build takes from the
// environment.
type checkoutStamp struct {
	Commit         string    `json:"commit"`
	Dirty          bool      `json:"dirty"`
	DirtyFiles     []string  `json:"dirtyFiles"`
	DesktopVersion string    `json:"desktopVersion"`
	SyncedAtUtc    time.Time `json:"syncedAtUtc"`
	// EngineVersion is `git describe` of the engine, as a local build stamps it.
	EngineVersion string `json:"-"`
}

// env are the variables that version a build of a tree with no git history.
func (s checkoutStamp) env() []string {
	dirty := "0"
	if s.Dirty {
		dirty = "1"
	}
	return []string{"ION_DESKTOP_VERSION=" + s.DesktopVersion, "ION_ENGINE_VERSION=" + s.EngineVersion,
		"ION_BUILD_COMMIT=" + shortCommit(s.Commit), "ION_BUILD_DIRTY=" + dirty, "HUSKY=0"}
}

func shortCommit(c string) string {
	if len(c) > 9 {
		return c[:9]
	}
	return c
}

// readStamp reads what the checkout is, from its git history.
func (a *Artifacts) readStamp(ctx context.Context, checkout string) (checkoutStamp, error) {
	// run returns a command's output as printed: a porcelain status line
	// starts with a space that trimming would eat.
	run := func(dir, name string, args ...string) (string, error) {
		var out, errOut bytes.Buffer
		if err := a.exec(ctx, ExecSpec{Dir: dir, Name: name, Args: args, Stdout: &out, Stderr: &errOut}); err != nil {
			return "", fmt.Errorf("%s %s: %w %s", name, strings.Join(args, " "), err, strings.TrimSpace(errOut.String()))
		}
		return strings.TrimRight(out.String(), "\n"), nil
	}
	s := checkoutStamp{SyncedAtUtc: time.Now().UTC().Truncate(time.Second), DirtyFiles: []string{}}
	var err error
	if s.Commit, err = run(checkout, "git", "rev-parse", "HEAD"); err != nil {
		return s, err
	}
	s.Commit = strings.TrimSpace(s.Commit)
	status, err := run(checkout, "git", "status", "--porcelain", "--untracked-files=all")
	if err != nil {
		return s, err
	}
	for _, line := range strings.Split(status, "\n") {
		if len(line) > 3 {
			s.DirtyFiles = append(s.DirtyFiles, line[3:])
		}
	}
	s.Dirty = len(s.DirtyFiles) > 0
	if s.EngineVersion, err = run(filepath.Join(checkout, "engine"), "git", "describe", "--tags", "--always", "--dirty"); err != nil {
		return s, err
	}
	if s.DesktopVersion, err = run(checkout, "node", "desktop/scripts/desktop-version.js"); err != nil {
		return s, err
	}
	s.EngineVersion, s.DesktopVersion = strings.TrimSpace(s.EngineVersion), strings.TrimSpace(s.DesktopVersion)
	return s, nil
}

// writeArchive writes the checkout's files under buildRoots as they are in
// the working tree, tracked or new (what git ignores stays behind), and the
// stamp, as one gzipped tar: a build on a host builds what a build here
// would.
func (a *Artifacts) writeArchive(ctx context.Context, checkout string, stamp checkoutStamp, w io.Writer) (int, error) {
	var list bytes.Buffer
	if err := a.exec(ctx, ExecSpec{Dir: checkout, Name: "git", Args: append([]string{"ls-files", "-z", "--cached", "--others", "--exclude-standard", "--"}, buildRoots...), Stdout: &list, Stderr: io.Discard}); err != nil {
		return 0, fmt.Errorf("list the checkout's files: %w", err)
	}
	gz := gzip.NewWriter(w)
	tw := tar.NewWriter(gz)
	count := 0
	for _, rel := range strings.Split(strings.TrimRight(list.String(), "\x00"), "\x00") {
		if rel == "" {
			continue
		}
		added, err := addToTar(tw, checkout, rel)
		if err != nil {
			return count, err
		}
		if added {
			count++
		}
	}
	data, err := json.MarshalIndent(stamp, "", "  ")
	if err != nil {
		return count, err
	}
	if err := tw.WriteHeader(&tar.Header{Name: ".ion-sync-stamp.json", Mode: 0o644, Size: int64(len(data)), ModTime: stamp.SyncedAtUtc}); err != nil {
		return count, err
	}
	if _, err := tw.Write(data); err != nil {
		return count, err
	}
	if err := tw.Close(); err != nil {
		return count, err
	}
	return count, gz.Close()
}

// addToTar adds one file; a tracked file deleted in the working tree is left
// out, as the working tree is what builds.
func addToTar(tw *tar.Writer, root, rel string) (bool, error) {
	path := filepath.Join(root, filepath.FromSlash(rel))
	info, err := os.Lstat(path)
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	link := ""
	if info.Mode()&os.ModeSymlink != 0 {
		if link, err = os.Readlink(path); err != nil {
			return false, err
		}
	}
	hdr, err := tar.FileInfoHeader(info, link)
	if err != nil {
		return false, err
	}
	hdr.Name = rel
	if err := tw.WriteHeader(hdr); err != nil {
		return false, err
	}
	if !info.Mode().IsRegular() {
		return true, nil
	}
	f, err := os.Open(path)
	if err != nil {
		return false, err
	}
	defer f.Close() //nolint:errcheck // read-only file
	_, err = io.Copy(tw, f)
	return err == nil, err
}

// posixPrepareBuildDir replaces the build folder's ($D) contents with the
// shipped checkout, keeping every node_modules folder, and unpacks it.
const posixPrepareBuildDir = `set -e
mkdir -p "$D"
cd "$D"
find . -path '*/node_modules' -prune -o -type f -print0 | xargs -0 rm -f
find . -path '*/node_modules' -prune -o -type l -print0 | xargs -0 rm -f
find . -mindepth 1 -type d -empty -not -path '*/node_modules*' -delete 2>/dev/null || true
tar xzf "$HOME/.ion/fleet-build/src.tgz"
rm -f "$HOME/.ion/fleet-build/src.tgz"
`

// posixEnsureDeps runs npm ci when the lockfile changed since the last
// install in this folder.
const posixEnsureDeps = `LOCK=$( (sha256sum package-lock.json 2>/dev/null || shasum -a 256 package-lock.json) | cut -d' ' -f1)
if [ -d node_modules ] && [ "$(cat node_modules/.ion-lock-hash 2>/dev/null)" = "$LOCK" ]; then
  echo "npm ci skipped: package-lock.json unchanged"
else
  npm ci --no-audit --no-fund
  echo "$LOCK" > node_modules/.ion-lock-hash
fi
`

// psPrepareBuildDir is posixPrepareBuildDir for a Windows builder ($d).
const psPrepareBuildDir = `New-Item -ItemType Directory -Force -Path $d | Out-Null
function Clear-KeepingModules([string]$dir) {
  foreach ($e in Get-ChildItem -LiteralPath $dir -Force) {
    if ($e.PSIsContainer) {
      if ($e.Name -eq 'node_modules') { continue }
      Clear-KeepingModules $e.FullName
      if (-not (Get-ChildItem -LiteralPath $e.FullName -Force)) { Remove-Item -LiteralPath $e.FullName -Force }
    } else { Remove-Item -LiteralPath $e.FullName -Force }
  }
}
Clear-KeepingModules $d
$src = Join-Path $env:USERPROFILE '.ion\fleet-build\src.tgz'
tar -xzf $src -C $d
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("tar exited $LASTEXITCODE"); exit 1 }
Remove-Item -LiteralPath $src -Force
`

// remoteBuildScript builds one artifact in the build folder and prints its
// path, relative to the folder, as ARTIFACT=<path> (and a Mac package's
// CPUs as ARCHS=).
func remoteBuildScript(b BuildPlan, dir string, stamp checkoutStamp) (script string, windows bool) {
	if b.GOOS == "windows" {
		arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[b.GOARCH]
		var env strings.Builder
		for _, kv := range stamp.env() {
			k, v, _ := strings.Cut(kv, "=")
			fmt.Fprintf(&env, "$env:%s = %s\n", k, psQuote(v))
		}
		return "$d = " + psBuildDir(dir) + "\n" + psPrepareBuildDir + psFreshPath + env.String() + `Set-Location $d
& powershell -NoProfile -ExecutionPolicy Bypass -File .\make.ps1 installer -Arch ` + arch + `
if ($LASTEXITCODE -ne 0) { [Console]::Error.WriteLine("make.ps1 installer exited $LASTEXITCODE"); exit 1 }
$exe = Get-ChildItem -LiteralPath (Join-Path $d 'desktop\release') -Filter 'Ion-Setup-*-` + arch + `.exe' | Sort-Object LastWriteTime -Descending | Select-Object -First 1
if (-not $exe) { [Console]::Error.WriteLine('the build left no installer under desktop\release'); exit 1 }
"ARTIFACT=desktop/release/$($exe.Name)"
`, true
	}
	var env []string
	for _, kv := range stamp.env() {
		k, v, _ := strings.Cut(kv, "=")
		env = append(env, "export "+k+"="+shellQuote(v))
	}
	build := fleetToolsPath + "D=" + posixBuildDir(dir) + "\n" + posixPrepareBuildDir + strings.Join(env, "\n") + "\n" + posixEnsureDeps
	if b.Component == ComponentServer {
		build += "bash scripts/package-studio-server.sh " + b.GOOS + " " + b.GOARCH + " build/deploy\n" +
			"echo ARTIFACT=build/deploy/ion-studio-server-" + b.GOOS + "-" + b.GOARCH + ".tar.gz\n"
	} else {
		build += `make desktop-pkg
PKG=$(ls -t desktop/release/Ion-*.pkg | head -n 1)
[ -n "$PKG" ] || { echo "the build left no installer package under desktop/release" >&2; exit 1; }
APP=$(ls -d desktop/release/mac*/Ion.app 2>/dev/null | head -n 1)
[ -n "$APP" ] && echo "ARCHS=$(lipo -archs "$APP/Contents/MacOS/Ion" 2>/dev/null)"
echo "ARTIFACT=$PKG"
`
	}
	return loginShell(build), false
}

// shipCheckout packs the checkout once per deploy and copies it to the host,
// where a build script unpacks it into the build folder.
func (d *Deployer) shipCheckout(ctx context.Context, h Host, windows bool, checkout string, log installLog) (checkoutStamp, error) {
	stamp, archive, err := d.checkoutArchive(ctx, checkout)
	if err != nil {
		return stamp, err
	}
	log.step("ship %s (%s%s) to %s", checkout, shortCommit(stamp.Commit), map[bool]string{true: ", with uncommitted changes", false: ""}[stamp.Dirty], h.Name)
	mkdir := "mkdir -p \"$HOME/.ion/fleet-build\""
	if windows {
		mkdir = "New-Item -ItemType Directory -Force -Path (Join-Path $env:USERPROFILE '.ion\\fleet-build') | Out-Null\n"
	}
	if _, err := hostCmd(ctx, d.Runner, h, windows, mkdir, nil, log); err != nil {
		return stamp, err
	}
	if err := d.Runner.CopyTo(ctx, h, archive, ".ion/fleet-build/src.tgz"); err != nil {
		return stamp, fmt.Errorf("copy the checkout to %s: %w", h.Name, err)
	}
	return stamp, nil
}

// scriptError is a line a build script prints for the error that ended it.
var scriptError = regexp.MustCompile(`\bERROR\s+(\S.*)$`)

// scriptFailure is why a build script on a host failed, in one line: the last
// error the script printed, else the last line of its stderr. A script's exit
// status alone says only that it failed.
func scriptFailure(out, stderr []byte) string {
	lines := strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n")
	for i := len(lines) - 1; i >= 0; i-- {
		if m := scriptError.FindStringSubmatch(strings.TrimSpace(lines[i])); m != nil {
			return m[1]
		}
	}
	if msg := strings.TrimSpace(string(stderr)); msg != "" {
		return lastTextLine(msg)
	}
	return ""
}

// buildOnHost ships the checkout to the builder, builds there, and fetches
// the artifact into the local artifacts folder.
func (d *Deployer) buildOnHost(ctx context.Context, b BuildPlan, checkout string, w io.Writer, report func(step string)) (artifact, error) {
	h := *b.Builder
	log := newInstallLog(w, h.Name, InstallOptions{OnStep: report})
	windows := b.GOOS == "windows"
	stamp, err := d.shipCheckout(ctx, h, windows, checkout, log)
	if err != nil {
		return artifact{}, err
	}
	log.step("build the %s/%s %s on %s", b.GOOS, b.GOARCH, b.Component, h.Name)
	dir := h.BuildDirOrDefault()
	script, _ := remoteBuildScript(b, dir, stamp)
	started := time.Now()
	out, stderr, err := d.Runner.RunLogged(ctx, h, script, windows, w)
	if err != nil {
		if why := scriptFailure(out, stderr); why != "" {
			err = fmt.Errorf("%w: %s", err, why)
		}
		return artifact{}, fmt.Errorf("the build on %s failed: %w", h.Name, err)
	}
	var rel, archs string
	for _, line := range strings.Split(strings.ReplaceAll(string(out), "\r", ""), "\n") {
		if v, ok := strings.CutPrefix(line, "ARTIFACT="); ok {
			rel = strings.TrimSpace(v)
		}
		if v, ok := strings.CutPrefix(line, "ARCHS="); ok {
			archs = strings.TrimSpace(v)
		}
	}
	if rel == "" {
		return artifact{}, fmt.Errorf("the build on %s named no artifact", h.Name)
	}
	fetched := filepath.Join(d.Artifacts.artifactsDir(), logName(b.Key))
	if err := os.MkdirAll(fetched, 0o700); err != nil {
		return artifact{}, err
	}
	local := filepath.Join(fetched, filepath.Base(rel))
	log.step("fetch %s from %s", filepath.Base(rel), h.Name)
	if err := d.Runner.CopyFrom(ctx, h, strings.ReplaceAll(dir, `\`, "/")+"/"+rel, local); err != nil {
		return artifact{}, fmt.Errorf("fetch the build from %s: %w", h.Name, err)
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "remote build fetched", map[string]any{"artifact": b.Key, "builder": h.Name, "path": local, "archs": archs, "build_seconds": int(time.Since(started).Seconds())})
	return artifact{path: local, archs: archs}, nil
}

// checkoutArchive writes the checkout's archive once per deploy.
func (d *Deployer) checkoutArchive(ctx context.Context, checkout string) (checkoutStamp, string, error) {
	d.archiveOnce.Do(func() {
		d.archiveStamp, d.archiveErr = d.Artifacts.readStamp(ctx, checkout)
		if d.archiveErr != nil {
			d.archiveErr = fmt.Errorf("read the checkout's version: %w", d.archiveErr)
			return
		}
		f, err := os.CreateTemp("", "ion-fleet-checkout-*.tgz")
		if err != nil {
			d.archiveErr = err
			return
		}
		defer f.Close() //nolint:errcheck // the write's own error is the one reported
		d.archivePath = f.Name()
		count, err := d.Artifacts.writeArchive(ctx, checkout, d.archiveStamp, f)
		if err != nil {
			d.archiveErr = fmt.Errorf("pack the checkout: %w", err)
			return
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "checkout packed for builders", map[string]any{"checkout": checkout, "files": count, "commit": d.archiveStamp.Commit, "dirty": d.archiveStamp.Dirty, "desktop_version": d.archiveStamp.DesktopVersion})
	})
	return d.archiveStamp, d.archivePath, d.archiveErr
}

package fleet

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/dsswift/ion/engine/internal/compat"
	"github.com/dsswift/ion/engine/internal/utils"
)

// errNoRelease: nothing is published for a release deploy to install.
var errNoRelease = errors.New("no Studio Server release is published yet; deploy with --source dev")

// Artifacts builds, downloads, and inspects what a deploy installs.
type Artifacts struct {
	// Exec runs a local command; ExecLocal by default.
	Exec func(ctx context.Context, spec ExecSpec) error
	// Download fetches a URL to a file; httpDownload by default.
	Download func(ctx context.Context, url, dest string) error
	// CacheDir keeps downloaded releases.
	CacheDir string
	// ArtifactsDir keeps builds fetched from builder hosts, one folder per
	// platform; StateDir()/artifacts by default.
	ArtifactsDir string

	// dev caches each checkout's formats for the life of this process.
	devMu sync.Mutex
	dev   map[string]devFormats
}

type devFormats struct {
	formats []compat.Format
	err     error
}

func (a *Artifacts) exec(ctx context.Context, spec ExecSpec) error {
	if a.Exec != nil {
		return a.Exec(ctx, spec)
	}
	return ExecLocal(ctx, spec)
}

// ExecLocal runs a command on this Mac. An interactive one also gets this
// terminal: its stdin, so a sudo prompt on the host can be answered, and its
// output mirrored beside the log.
func ExecLocal(ctx context.Context, spec ExecSpec) error {
	cmd := exec.CommandContext(ctx, spec.Name, spec.Args...)
	cmd.Dir = spec.Dir
	cmd.Env = append(os.Environ(), spec.Env...)
	cmd.Stdout, cmd.Stderr = spec.Stdout, spec.Stderr
	if spec.Interactive {
		cmd.Stdin = os.Stdin
		cmd.Stdout = teeTo(spec.Stdout, os.Stdout)
		cmd.Stderr = teeTo(spec.Stderr, os.Stderr)
	}
	return cmd.Run()
}

func teeTo(w io.Writer, terminal io.Writer) io.Writer {
	if w == nil {
		return terminal
	}
	return io.MultiWriter(w, terminal)
}

// TargetFormats reads the Format Versions the target's new build speaks.
func (a *Artifacts) TargetFormats(ctx context.Context, checkout, source string, t Target, latest Latest) ([]compat.Format, error) {
	if source == SourceDev {
		a.devMu.Lock()
		defer a.devMu.Unlock()
		if got, ok := a.dev[checkout]; ok {
			return got.formats, got.err
		}
		formats, err := a.checkoutFormats(ctx, checkout)
		if a.dev == nil {
			a.dev = map[string]devFormats{}
		}
		a.dev[checkout] = devFormats{formats, err}
		return formats, err
	}
	switch {
	case t.Component == ComponentDesktop && t.GOOS == "windows":
		// A Windows installer cannot be opened here to read its formats.
		return nil, errors.New("a Windows installer's formats are read once it is installed")
	case t.Component == ComponentServer:
		dir, err := a.ServerRelease(ctx, latest, t.GOOS, t.GOARCH)
		if err != nil {
			return nil, err
		}
		return a.readInstallFormats(ctx, filepath.Join(dir, "bin", "ion"), filepath.Join(dir, "compat.json"))
	default:
		app, err := a.DesktopReleaseApp(ctx, latest)
		if err != nil {
			return nil, err
		}
		return a.readInstallFormats(ctx, filepath.Join(app, "Contents", "Resources", "engine", "ion"),
			filepath.Join(app, "Contents", "Resources", "app.asar.unpacked", "dist", "server", "compat.json"))
	}
}

// checkoutFormats reads the checkout's registries: the engine's through
// `go run ... version --json`, the server's through a fresh server build's
// compat script. Every build of this checkout speaks these.
func (a *Artifacts) checkoutFormats(ctx context.Context, checkout string) ([]compat.Format, error) {
	var engineOut, serverOut, discard bytes.Buffer
	if err := a.exec(ctx, ExecSpec{Dir: filepath.Join(checkout, "engine"), Name: "go", Args: []string{"run", "./cmd/ion", "version", "--json"}, Stdout: &engineOut, Stderr: &discard}); err != nil {
		return nil, fmt.Errorf("read the checkout's engine formats: %w", err)
	}
	if err := a.exec(ctx, ExecSpec{Dir: checkout, Name: "npm", Args: []string{"-w", "server", "run", "build"}, Stdout: &discard, Stderr: &discard}); err != nil {
		return nil, fmt.Errorf("build the checkout's server to read its formats: %w", err)
	}
	if err := a.exec(ctx, ExecSpec{Dir: checkout, Name: "node", Args: []string{"server/dist/compat.js"}, Stdout: &serverOut, Stderr: &discard}); err != nil {
		return nil, fmt.Errorf("read the checkout's server formats: %w", err)
	}
	var engine struct {
		Formats []compat.Format `json:"formats"`
	}
	var server struct {
		Formats []compat.Format `json:"formats"`
	}
	if err := json.Unmarshal(engineOut.Bytes(), &engine); err != nil {
		return nil, fmt.Errorf("parse the checkout's engine formats: %w", err)
	}
	if err := json.Unmarshal(serverOut.Bytes(), &server); err != nil {
		return nil, fmt.Errorf("parse the checkout's server formats: %w", err)
	}
	return append(engine.Formats, server.Formats...), nil
}

// readInstallFormats reads an unpacked build: its server's compat.json and
// its engine's `version --json`. An engine built for another platform cannot
// run here; its formats are then missing, not guessed.
func (a *Artifacts) readInstallFormats(ctx context.Context, ionBin, compatJSON string) ([]compat.Format, error) {
	var out []compat.Format
	var problems []string
	var stdout, discard bytes.Buffer
	if err := a.exec(ctx, ExecSpec{Name: ionBin, Args: []string{"version", "--json"}, Stdout: &stdout, Stderr: &discard}); err == nil {
		var v struct {
			Formats []compat.Format `json:"formats"`
		}
		if json.Unmarshal(stdout.Bytes(), &v) == nil {
			out = append(out, v.Formats...)
		}
	} else {
		problems = append(problems, "engine: "+err.Error())
	}
	if data, err := os.ReadFile(compatJSON); err == nil {
		var s struct {
			Formats []compat.Format `json:"formats"`
		}
		if json.Unmarshal(data, &s) == nil {
			out = append(out, s.Formats...)
		}
	} else {
		problems = append(problems, "server: the build predates compat.json")
	}
	if len(problems) > 0 {
		return out, errors.New(strings.Join(problems, "; "))
	}
	return out, nil
}

// BuildServer packages this checkout's Studio Server bundle for one platform
// into <checkout>/build/deploy, where a --no-build deploy finds it.
func (a *Artifacts) BuildServer(ctx context.Context, checkout, goos, goarch string, log io.Writer) error {
	return a.exec(ctx, ExecSpec{Dir: checkout, Name: "bash", Args: []string{"scripts/package-studio-server.sh", goos, goarch, "build/deploy"}, Stdout: log, Stderr: log})
}

// BuildDesktop builds this checkout's desktop installer package and returns it.
func (a *Artifacts) BuildDesktop(ctx context.Context, checkout string, log io.Writer) (string, error) {
	pattern := filepath.Join(checkout, "desktop", "release", "Ion-*.pkg")
	before := globModTimes(pattern)
	if err := a.exec(ctx, ExecSpec{Dir: checkout, Name: "make", Args: []string{"desktop-pkg"}, Stdout: log, Stderr: log}); err != nil {
		return "", fmt.Errorf("make desktop-pkg: %w", err)
	}
	pkg := newestWrittenSince(pattern, before)
	if pkg == "" {
		return "", errors.New("make desktop-pkg left no new installer package under desktop/release")
	}
	return pkg, nil
}

// globModTimes records each file matching pattern and its modification time.
func globModTimes(pattern string) map[string]time.Time {
	files, _ := filepath.Glob(pattern) //nolint:errcheck // only ErrBadPattern, and the patterns are fixed
	out := make(map[string]time.Time, len(files))
	for _, f := range files {
		out[f] = modTime(f)
	}
	return out
}

// newestWrittenSince is the newest file matching pattern that is not in
// before, or whose modification time changed since. It compares recorded
// times rather than a clock reading, since a file system may store times
// more coarsely than the clock.
func newestWrittenSince(pattern string, before map[string]time.Time) string {
	newest, newestTime := "", time.Time{}
	for f, t := range globModTimes(pattern) {
		if prev, ok := before[f]; ok && prev.Equal(t) {
			continue
		}
		if newest == "" || t.After(newestTime) {
			newest, newestTime = f, t
		}
	}
	return newest
}

func (a *Artifacts) artifactsDir() string {
	if a.ArtifactsDir != "" {
		return a.ArtifactsDir
	}
	return filepath.Join(StateDir(), "artifacts")
}

// existingBuild is a build already made for a target: this checkout's own
// (a Mac package, a server bundle), else the newest one fetched from a
// builder host.
func (a *Artifacts) existingBuild(checkout string, t Target, key string) artifact {
	here := localPlatform()
	switch {
	case t.Component == ComponentServer && canBuildHere(t.Component, t.GOOS, t.GOARCH, here):
		bundle := filepath.Join(checkout, "build", "deploy", "ion-studio-server-"+t.GOOS+"-"+t.GOARCH+".tar.gz")
		if _, err := os.Stat(bundle); err != nil {
			return artifact{err: fmt.Errorf("no bundle at %s (deploy without --no-build)", bundle)}
		}
		return artifact{path: bundle}
	case t.Component == ComponentDesktop && t.GOOS == "darwin" && canBuildHere(t.Component, t.GOOS, t.GOARCH, here):
		pkg, err := a.NewestDesktopPkg(checkout)
		return artifact{path: pkg, archs: a.PackageArchs(checkout, pkg), err: err}
	}
	files, err := filepath.Glob(filepath.Join(a.artifactsDir(), strings.ReplaceAll(key, "/", "-"), "*"))
	if err != nil || len(files) == 0 {
		return artifact{err: fmt.Errorf("no %s build has been fetched yet (deploy without --no-build)", key)}
	}
	sort.Slice(files, func(i, j int) bool { return modTime(files[i]).After(modTime(files[j])) })
	return artifact{path: files[0]}
}

// BuildWindowsDesktop builds the checkout's Windows installer on this
// Windows machine and returns it.
func (a *Artifacts) BuildWindowsDesktop(ctx context.Context, checkout, goarch string, log io.Writer) (string, error) {
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[goarch]
	pattern := filepath.Join(checkout, "desktop", "release", "Ion-Setup-*-"+arch+".exe")
	before := globModTimes(pattern)
	if err := a.exec(ctx, ExecSpec{Dir: checkout, Name: "powershell", Args: []string{"-NoProfile", "-ExecutionPolicy", "Bypass", "-File", "make.ps1", "installer", "-Arch", arch}, Stdout: log, Stderr: log}); err != nil {
		return "", fmt.Errorf("make.ps1 installer: %w", err)
	}
	exe := newestWrittenSince(pattern, before)
	if exe == "" {
		return "", errors.New("make.ps1 installer left no new installer under desktop/release")
	}
	return exe, nil
}

// NewestDesktopPkg is the newest installer package the checkout has built.
func (a *Artifacts) NewestDesktopPkg(checkout string) (string, error) {
	pkgs, err := filepath.Glob(filepath.Join(checkout, "desktop", "release", "Ion-*.pkg"))
	if err != nil {
		return "", err
	}
	sort.Slice(pkgs, func(i, j int) bool { return modTime(pkgs[i]).After(modTime(pkgs[j])) })
	if len(pkgs) == 0 {
		return "", errors.New("no installer package under desktop/release (deploy without --no-build, or pass --pkg)")
	}
	return pkgs[0], nil
}

// PackageArchs are the CPUs of the app a checkout built beside pkg, read
// with lipo; empty when unknown (a package from elsewhere, or no lipo).
func (a *Artifacts) PackageArchs(checkout, pkg string) string {
	if checkout == "" || !strings.HasSuffix(pkg, ".pkg") || filepath.Dir(pkg) != filepath.Join(checkout, "desktop", "release") {
		return ""
	}
	apps, err := filepath.Glob(filepath.Join(checkout, "desktop", "release", "mac*", "Ion.app"))
	if err != nil || len(apps) == 0 {
		return ""
	}
	var out, discard bytes.Buffer
	if err := a.exec(context.Background(), ExecSpec{Name: "lipo", Args: []string{"-archs", filepath.Join(apps[0], "Contents", "MacOS", "Ion")}, Stdout: &out, Stderr: &discard}); err != nil {
		return ""
	}
	return strings.TrimSpace(out.String())
}

func modTime(path string) time.Time {
	info, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return info.ModTime()
}

// ServerRelease downloads and unpacks the latest Studio Server bundle for a
// platform, returning the bundle directory.
func (a *Artifacts) ServerRelease(ctx context.Context, latest Latest, goos, goarch string) (string, error) {
	if latest.Server == "" {
		return "", errNoRelease
	}
	name := fmt.Sprintf("ion-studio-server-%s-%s.tar.gz", goos, goarch)
	asset, ok := findAsset(latest.ServerAssets, name)
	if !ok {
		return "", fmt.Errorf("server release %s has no %s", latest.Server, name)
	}
	file, err := a.fetch(ctx, "server-"+latest.Server, asset)
	if err != nil {
		return "", err
	}
	dir := strings.TrimSuffix(file, ".tar.gz")
	if _, err := os.Stat(filepath.Join(dir, "ion-studio-server")); err != nil {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return "", err
		}
		var discard bytes.Buffer
		if err := a.exec(ctx, ExecSpec{Name: "tar", Args: []string{"-xzf", file, "-C", dir}, Stdout: &discard, Stderr: &discard}); err != nil {
			return "", fmt.Errorf("unpack %s: %w", name, err)
		}
	}
	return filepath.Join(dir, "ion-studio-server"), nil
}

// DesktopReleasePkg downloads the latest desktop installer package.
func (a *Artifacts) DesktopReleasePkg(ctx context.Context, latest Latest) (string, error) {
	if latest.Desktop == "" {
		return "", errors.New("no desktop release is published")
	}
	for _, asset := range latest.DesktopAssets {
		if strings.HasSuffix(asset.Name, ".pkg") {
			return a.fetch(ctx, "desktop-"+latest.Desktop, asset)
		}
	}
	return "", fmt.Errorf("desktop release %s has no .pkg", latest.Desktop)
}

// DesktopReleaseSetup downloads the latest desktop's Windows installer for
// one CPU (Ion-Setup-<version>-<arm64|x64>.exe).
func (a *Artifacts) DesktopReleaseSetup(ctx context.Context, latest Latest, goarch string) (string, error) {
	if latest.Desktop == "" {
		return "", errors.New("no desktop release is published")
	}
	arch := map[string]string{"arm64": "arm64", "amd64": "x64"}[goarch]
	name := fmt.Sprintf("Ion-Setup-%s-%s.exe", latest.Desktop, arch)
	asset, ok := findAsset(latest.DesktopAssets, name)
	if !ok {
		return "", fmt.Errorf("desktop release %s has no %s", latest.Desktop, name)
	}
	return a.fetch(ctx, "desktop-"+latest.Desktop, asset)
}

// DesktopReleaseApp expands the release package and returns the Ion.app in it.
func (a *Artifacts) DesktopReleaseApp(ctx context.Context, latest Latest) (string, error) {
	pkg, err := a.DesktopReleasePkg(ctx, latest)
	if err != nil {
		return "", err
	}
	dir := strings.TrimSuffix(pkg, ".pkg") + "-expanded"
	if _, err := os.Stat(dir); err != nil {
		var discard bytes.Buffer
		if err := a.exec(ctx, ExecSpec{Name: "pkgutil", Args: []string{"--expand-full", pkg, dir}, Stdout: &discard, Stderr: &discard}); err != nil {
			return "", fmt.Errorf("expand %s: %w", filepath.Base(pkg), err)
		}
	}
	var app string
	walkErr := filepath.WalkDir(dir, func(path string, d os.DirEntry, err error) error {
		if err == nil && d.IsDir() && d.Name() == "Ion.app" {
			app = path
			return filepath.SkipAll
		}
		return nil
	})
	if walkErr != nil || app == "" {
		return "", fmt.Errorf("no Ion.app inside %s", filepath.Base(pkg))
	}
	return app, nil
}

func findAsset(assets []ReleaseAsset, name string) (ReleaseAsset, bool) {
	for _, a := range assets {
		if a.Name == name {
			return a, true
		}
	}
	return ReleaseAsset{}, false
}

// fetch downloads a release asset into the cache once and checks it against
// the SHA-256 digest GitHub publishes for it.
func (a *Artifacts) fetch(ctx context.Context, release string, asset ReleaseAsset) (string, error) {
	dir := filepath.Join(a.CacheDir, release)
	dest := filepath.Join(dir, asset.Name)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", err
	}
	if _, err := os.Stat(dest); err != nil {
		download := a.Download
		if download == nil {
			download = httpDownload
		}
		utils.LogWithFields(utils.LevelInfo, logTag, "downloading release asset", map[string]any{"release": release, "asset": asset.Name})
		if err := download(ctx, asset.URL, dest+".part"); err != nil {
			return "", fmt.Errorf("download %s: %w", asset.Name, err)
		}
		if err := os.Rename(dest+".part", dest); err != nil {
			return "", err
		}
	}
	if err := verifyDigest(dest, asset.Digest); err != nil {
		if rmErr := os.Remove(dest); rmErr != nil {
			utils.LogWithFields(utils.LevelWarn, logTag, "could not remove an asset that failed its digest", map[string]any{"path": dest, "error": rmErr.Error()})
		}
		return "", err
	}
	return dest, nil
}

// verifyDigest checks a file against "sha256:<hex>". A release without a
// published digest is refused: nothing unverified is installed.
func verifyDigest(path, digest string) error {
	want, ok := strings.CutPrefix(digest, "sha256:")
	if !ok || want == "" {
		return fmt.Errorf("%s has no published sha256 digest to check it against", filepath.Base(path))
	}
	f, err := os.Open(path)
	if err != nil {
		return err
	}
	defer f.Close() //nolint:errcheck // read-only file
	h := sha256.New()
	if _, err := io.Copy(h, f); err != nil {
		return err
	}
	if got := hex.EncodeToString(h.Sum(nil)); got != want {
		return fmt.Errorf("%s does not match its published digest (got %s, want %s)", filepath.Base(path), got, want)
	}
	return nil
}

func httpDownload(ctx context.Context, url, dest string) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return err
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if resp.StatusCode != http.StatusOK {
		return fmt.Errorf("HTTP %d", resp.StatusCode)
	}
	f, err := os.OpenFile(dest, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o600)
	if err != nil {
		return err
	}
	if _, err := io.Copy(f, resp.Body); err != nil {
		f.Close() //nolint:errcheck // the copy error is the one reported
		return err
	}
	return f.Close()
}

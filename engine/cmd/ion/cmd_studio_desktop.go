package main

// cmd_studio_desktop.go — reading the Ion desktop installed on this host: its
// version, and the Studio server and engine it carries. A desktop runs its own
// server as a child and its engine as a user service (a LaunchAgent on macOS,
// a Scheduled Task on Windows), so a host with only the desktop is still an
// Environment `ion studio status` reports.

import (
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"

	"github.com/dsswift/ion/engine/internal/studiostatus"
)

// desktopInstall is an installed Ion desktop: where it lives on this OS and
// the version its installer recorded.
type desktopInstall struct {
	GOOS    string
	Root    string // Ion.app on macOS, the install folder on Windows
	Version string
}

func (d desktopInstall) resources() string {
	if d.GOOS == "windows" {
		return filepath.Join(d.Root, "resources")
	}
	return filepath.Join(d.Root, "Contents", "Resources")
}

// engineBin is the engine the desktop carries.
func (d desktopInstall) engineBin() string {
	if d.GOOS == "windows" {
		return filepath.Join(d.resources(), "engine", "ion.exe")
	}
	return filepath.Join(d.resources(), "engine", "ion")
}

// serverFile is a file beside the desktop's embedded server bundle.
func (d desktopInstall) serverFile(name string) string {
	return filepath.Join(d.resources(), "app.asar.unpacked", "dist", "server", name)
}

// executable is the app binary, which also runs Node scripts under
// ELECTRON_RUN_AS_NODE=1.
func (d desktopInstall) executable() string {
	if d.GOOS == "windows" {
		return filepath.Join(d.Root, "Ion.exe")
	}
	return filepath.Join(d.Root, "Contents", "MacOS", "Ion")
}

// macDesktopApp is where the macOS installer puts the app.
const macDesktopApp = "/Applications/Ion.app"

// locateDesktop finds the desktop installed on this host; nil when none is.
func locateDesktop() (*desktopInstall, error) {
	switch runtime.GOOS {
	case "darwin":
		return locateMacDesktop(macDesktopApp)
	case "windows":
		entry, err := readUninstallEntry()
		if err != nil {
			return nil, err
		}
		return resolveWindowsDesktop(entry, windowsInstallCandidates(), fileExists), nil
	}
	return nil, nil
}

func locateMacDesktop(app string) (*desktopInstall, error) {
	if _, err := os.Stat(app); errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	version, err := desktopBundleVersion(app)
	if err != nil {
		return nil, err
	}
	return &desktopInstall{GOOS: "darwin", Root: app, Version: version}, nil
}

// uninstallEntry is the part of the desktop's Windows uninstall key a status
// reads (HKLM or HKCU ...\Uninstall\<app GUID>).
type uninstallEntry struct {
	DisplayVersion  string
	InstallLocation string
	DisplayIcon     string
}

// resolveWindowsDesktop finds the install folder: the key's InstallLocation,
// else the folder of its DisplayIcon (`C:\...\Ion.exe,0`), else the first
// candidate holding Ion.exe. No key and no Ion.exe means no desktop.
func resolveWindowsDesktop(entry *uninstallEntry, candidates []string, exists func(string) bool) *desktopInstall {
	var roots []string
	version := ""
	if entry != nil {
		version = entry.DisplayVersion
		if entry.InstallLocation != "" {
			roots = append(roots, strings.Trim(entry.InstallLocation, `"`))
		}
		if icon := strings.Trim(strings.SplitN(entry.DisplayIcon, ",", 2)[0], `"`); icon != "" {
			roots = append(roots, filepath.Dir(icon))
		}
	}
	roots = append(roots, candidates...)
	for _, root := range roots {
		d := desktopInstall{GOOS: "windows", Root: root, Version: version}
		if exists(d.executable()) {
			return &d
		}
	}
	return nil
}

// windowsInstallCandidates are the folders the installer uses: per-machine,
// then an older per-user install.
func windowsInstallCandidates() []string {
	var out []string
	if pf := os.Getenv("ProgramFiles"); pf != "" {
		out = append(out, filepath.Join(pf, "Ion"))
	}
	if la := os.Getenv("LOCALAPPDATA"); la != "" {
		out = append(out, filepath.Join(la, "Programs", "Ion"))
	}
	return out
}

func fileExists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

var plistShortVersion = regexp.MustCompile(`<key>CFBundleShortVersionString</key>\s*<string>([^<]+)</string>`)

// readDesktopApp reports an installed desktop and what it carries.
func readDesktopApp(inst *desktopInstall, d statusDeps) *studiostatus.DesktopApp {
	if inst == nil {
		return nil
	}
	out := &studiostatus.DesktopApp{Path: inst.Root, Version: inst.Version}
	if data, err := os.ReadFile(inst.serverFile("VERSION")); err == nil {
		out.ServerVersion = strings.TrimSpace(string(data))
	}
	if data, err := d.runVersionJSON(inst.engineBin()); err == nil {
		// An engine older than --json still prints its version.
		v, _ := parseVersionJSON(data) //nolint:errcheck // a pre-format engine still yields its version
		out.EngineVersion = v.Version
	}
	return out
}

// desktopBundleVersion reads CFBundleShortVersionString. The app's Info.plist
// is XML; plutil covers a binary one.
func desktopBundleVersion(app string) (string, error) {
	plist := filepath.Join(app, "Contents", "Info.plist")
	data, err := os.ReadFile(plist)
	if err != nil {
		return "", fmt.Errorf("read %s: %w", plist, err)
	}
	if m := plistShortVersion.FindSubmatch(data); m != nil {
		return strings.TrimSpace(string(m[1])), nil
	}
	out, err := exec.Command("/usr/bin/plutil", "-extract", "CFBundleShortVersionString", "raw", "-o", "-", plist).Output()
	if err != nil {
		return "", fmt.Errorf("no CFBundleShortVersionString in %s: %w", plist, err)
	}
	return strings.TrimSpace(string(out)), nil
}

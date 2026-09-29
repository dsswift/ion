package fleet

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
)

// This machine's shell: the fleet manager runs on macOS, Linux, or Windows,
// and a host whose target is "local" is this machine.

// localPlatform is this machine's platform.
var localPlatform = func() Platform { return Platform{GOOS: runtime.GOOS, GOARCH: runtime.GOARCH} }

// localCommand runs a command line in this machine's shell: sh, or
// PowerShell on Windows.
func localCommand(ctx context.Context, command string) *exec.Cmd {
	if localPlatform().Windows() {
		return exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-Command", command)
	}
	return exec.CommandContext(ctx, "/bin/sh", "-c", command)
}

// localPowerShell runs a PowerShell script on this Windows machine, with the
// same prelude a Windows host's scripts get.
func localPowerShell(ctx context.Context, script string) *exec.Cmd {
	return exec.CommandContext(ctx, "powershell", "-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encodePowerShell(psPrelude+script))
}

// localHostPlatform is this machine as a host: no probe needed.
func localHostPlatform() Platform {
	p := localPlatform()
	p.LoginShell = ShellPOSIX
	if p.Windows() {
		p.LoginShell = ShellPowerShell
	}
	return p
}

// copyLocal copies a file on this machine; a relative destination is under
// the home folder, as it is for a host.
func copyLocal(from, to string) error {
	if !filepath.IsAbs(to) {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		to = filepath.Join(home, to)
	}
	if !filepath.IsAbs(from) {
		home, err := os.UserHomeDir()
		if err != nil {
			return err
		}
		from = filepath.Join(home, from)
	}
	src, err := os.Open(from)
	if err != nil {
		return err
	}
	defer src.Close() //nolint:errcheck // read-only file
	info, err := src.Stat()
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(to), 0o700); err != nil {
		return err
	}
	dst, err := os.OpenFile(to, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, info.Mode().Perm())
	if err != nil {
		return err
	}
	if _, err := io.Copy(dst, src); err != nil {
		dst.Close() //nolint:errcheck // the copy error is the one reported
		return fmt.Errorf("copy %s to %s: %w", from, to, err)
	}
	return dst.Close()
}

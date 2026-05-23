package server

import (
	"fmt"
	"os"
	"os/user"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"sync"
)

// hostInfoCache caches the once-computed engine host info.
var (
	hostInfoOnce   sync.Once
	hostInfoCached map[string]interface{}
)

// listDirectoryMaxEntries caps the number of entries returned by a single
// list_directory call. Beyond this, the response is truncated and the client
// is told to narrow the path.
const listDirectoryMaxEntries = 5000

// computeHostInfo collects engine-host metadata that the desktop uses to
// browse the engine's filesystem (home, username, hostname, os, separator).
// The values are immutable for the lifetime of the daemon, so it caches once.
func computeHostInfo() map[string]interface{} {
	hostInfoOnce.Do(func() {
		home, _ := os.UserHomeDir()
		username := ""
		if u, err := user.Current(); err == nil {
			username = u.Username
		}
		hostname, _ := os.Hostname()
		hostInfoCached = map[string]interface{}{
			"home":     home,
			"username": username,
			"hostname": hostname,
			"os":       runtime.GOOS,
			"pathSep":  string(os.PathSeparator),
		}
	})
	return hostInfoCached
}

// fsEntry is one row in a list_directory response.
type fsEntry struct {
	Name      string `json:"name"`
	IsDir     bool   `json:"isDir"`
	IsSymlink bool   `json:"isSymlink"`
	Readable  bool   `json:"readable"`
}

// listDirectory enumerates a directory on the engine's host.
//
//   - path "" or "~" resolves to the engine user's home; "~/foo" is treated as
//     "<home>/foo".
//   - all other paths must be absolute; relative paths are rejected so the
//     client can never accidentally inherit the engine's cwd.
//   - per-entry permission errors are surfaced as readable=false rather than
//     failing the whole call.
//   - dotfiles are dropped unless showHidden.
//   - entries are sorted dirs-first, case-insensitive within each group.
//   - the response is capped at listDirectoryMaxEntries; truncated=true tells
//     the client to narrow the path.
//
// Symlinks are reported but never followed; the client may pass an explicit
// target path to navigate into one.
func listDirectory(path string, showHidden bool) (map[string]interface{}, error) {
	resolved, err := resolveBrowsePath(path)
	if err != nil {
		return nil, err
	}

	dirEntries, err := os.ReadDir(resolved)
	if err != nil {
		return nil, err
	}

	out := make([]fsEntry, 0, len(dirEntries))
	truncated := false
	for _, de := range dirEntries {
		name := de.Name()
		if !showHidden && strings.HasPrefix(name, ".") {
			continue
		}
		if len(out) >= listDirectoryMaxEntries {
			truncated = true
			break
		}

		entry := fsEntry{Name: name, Readable: true}
		mode := de.Type()
		if mode&os.ModeSymlink != 0 {
			entry.IsSymlink = true
			if info, statErr := os.Lstat(filepath.Join(resolved, name)); statErr == nil {
				// dir-ness based on the symlink itself, not its target.
				_ = info
			}
			// Resolve target to detect if it's a directory, but don't follow.
			if target, statErr := os.Stat(filepath.Join(resolved, name)); statErr == nil {
				entry.IsDir = target.IsDir()
			} else {
				entry.Readable = false
			}
		} else {
			entry.IsDir = mode.IsDir()
		}
		out = append(out, entry)
	}

	sort.SliceStable(out, func(i, j int) bool {
		if out[i].IsDir != out[j].IsDir {
			return out[i].IsDir
		}
		return strings.ToLower(out[i].Name) < strings.ToLower(out[j].Name)
	})

	resp := map[string]interface{}{
		"path":      resolved,
		"entries":   out,
		"truncated": truncated,
	}
	if parent := filepath.Dir(resolved); parent != resolved {
		resp["parent"] = parent
	} else {
		resp["parent"] = nil
	}
	return resp, nil
}

// resolveBrowsePath converts a client-supplied path into an absolute path on
// the engine's host. Returns an error if the path is relative.
func resolveBrowsePath(path string) (string, error) {
	if path == "" || path == "~" {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("home directory unavailable: %w", err)
		}
		return home, nil
	}
	if strings.HasPrefix(path, "~/") {
		home, err := os.UserHomeDir()
		if err != nil {
			return "", fmt.Errorf("home directory unavailable: %w", err)
		}
		return filepath.Join(home, strings.TrimPrefix(path, "~/")), nil
	}
	if !filepath.IsAbs(path) {
		return "", fmt.Errorf("path must be absolute: %q", path)
	}
	return filepath.Clean(path), nil
}

package main

// cmd_studio_update.go — `ion studio update [VERSION] [--yes]`.
//
// Same release mechanics as `ion upgrade` (GitHub release lookup,
// checksums.txt verification) against the `server-v*` tags that carry the
// Studio server bundle. The new version is extracted beside the running one
// and `current` is repointed atomically, so a failed download or a bad
// checksum never touches what the services are running. The restart is the
// only disruptive step (it interrupts running agent turns), so it asks
// unless --yes.

import (
	"bufio"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

const studioReleaseTag = "server-v"

// studioBundleAssetName is the tarball this platform installs.
func studioBundleAssetName(goos, goarch string) string {
	return fmt.Sprintf("ion-studio-server-%s-%s.tar.gz", goos, goarch)
}

// findLatestStudioRelease returns the newest non-draft, non-prerelease
// `server-v*` release that carries this platform's bundle.
func findLatestStudioRelease() (ver string, downloadURL string, err error) {
	return findStudioRelease("")
}

// findStudioRelease resolves one version (or the latest when want is empty)
// to its bundle download URL.
func findStudioRelease(want string) (string, string, error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases?per_page=30", githubRepo)
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", upgradeAgent)
	client := &http.Client{Timeout: 10 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return "", "", err
	}
	defer func() { resp.Body.Close() }() //nolint:errcheck // deferred close on read-only HTTP response body
	if resp.StatusCode != http.StatusOK {
		return "", "", fmt.Errorf("GitHub API returned %d", resp.StatusCode)
	}
	var releases []ghRelease
	if err := json.NewDecoder(resp.Body).Decode(&releases); err != nil {
		return "", "", fmt.Errorf("parse releases: %w", err)
	}
	return pickStudioRelease(releases, want, studioBundleAssetName(runtime.GOOS, runtime.GOARCH))
}

// pickStudioRelease is the pure selection step, split out for tests.
func pickStudioRelease(releases []ghRelease, want, asset string) (string, string, error) {
	for _, r := range releases {
		if !strings.HasPrefix(r.TagName, studioReleaseTag) || r.Draft || r.Prerelease {
			continue
		}
		v := strings.TrimPrefix(r.TagName, studioReleaseTag)
		if want != "" && v != want {
			continue
		}
		for _, a := range r.Assets {
			if a.Name == asset {
				return v, a.DownloadURL, nil
			}
		}
	}
	if want != "" {
		return "", "", fmt.Errorf("no %s release %s carries %s", studioReleaseTag, want, asset)
	}
	return "", "", fmt.Errorf("no %s release carries %s", studioReleaseTag, asset)
}

func fetchStudioChecksums(ver string) (map[string]string, error) {
	url := fmt.Sprintf("https://github.com/%s/releases/download/%s%s/checksums.txt", githubRepo, studioReleaseTag, ver)
	data, err := downloadAsset(url)
	if err != nil {
		return nil, err
	}
	return parseChecksums(string(data)), nil
}

// parseChecksums reads `<hash>  <name>` lines (sha256sum format).
func parseChecksums(text string) map[string]string {
	result := make(map[string]string)
	for _, line := range strings.Split(text, "\n") {
		parts := strings.Fields(strings.TrimSpace(line))
		if len(parts) != 2 {
			continue
		}
		result[strings.TrimPrefix(parts[1], "./")] = parts[0]
	}
	return result
}

func studioUpdate(l studioLayout, positional []string, yes bool) {
	want := ""
	if len(positional) > 0 {
		want = strings.TrimPrefix(positional[0], "v")
	}
	installed, err := readBundleVersion(l.current)
	if err != nil {
		studioFail("read installed VERSION", fmt.Errorf("no bundle at %s: %w", l.current, err))
	}
	studioSay("installed: server %s; checking releases", installed.Server)
	ver, url, err := findStudioRelease(want)
	if err != nil {
		studioFail("find release", err)
	}
	if ver == installed.Server {
		studioSay("already up to date: %s", ver)
		return
	}
	checksums, err := fetchStudioChecksums(ver)
	if err != nil {
		studioFail("fetch checksums", err)
	}
	asset := studioBundleAssetName(runtime.GOOS, runtime.GOARCH)
	expected, ok := checksums[asset]
	if !ok {
		studioFail("verify", fmt.Errorf("checksums.txt for %s%s has no entry for %s", studioReleaseTag, ver, asset))
	}
	studioSay("downloading %s %s", asset, ver)
	data, err := downloadAsset(url)
	if err != nil {
		studioFail("download", err)
	}
	if actual := sha256sum(data); actual != expected {
		studioFail("verify", fmt.Errorf("checksum mismatch for %s: expected %s, got %s", asset, expected, actual))
	}
	studioSay("checksum verified")
	dest, err := extractStudioBundle(l, ver, data)
	if err != nil {
		studioFail("extract", err)
	}
	if err := repointCurrent(l, dest); err != nil {
		studioFail("repoint current", err)
	}
	studioSay("installed %s at %s; current -> %s", ver, dest, dest)
	if !yes && !confirm(fmt.Sprintf("Restart the services now to run %s? This interrupts running agents. [y/N] ", ver)) {
		studioSay("not restarted; the services keep running %s until `ion studio restart`", installed.Server)
		return
	}
	studioRestart(l)
}

// studioUpdateFromBundle installs a bundle tarball already on this host: one
// built from source and sent here, where a release would be downloaded. It
// lands beside the installed versions under a name of its own, so it never
// replaces the tree the running services were started from.
func studioUpdateFromBundle(l studioLayout, path string, yes bool) {
	data, err := os.ReadFile(path)
	if err != nil {
		studioFail("read bundle", err)
	}
	name := "local-" + sha256sum(data)[:12]
	dest, err := extractStudioBundle(l, name, data)
	if err != nil {
		studioFail("extract", err)
	}
	version, err := readBundleVersion(dest)
	if err != nil {
		studioFail("read bundle VERSION", err)
	}
	if err := repointCurrent(l, dest); err != nil {
		studioFail("repoint current", err)
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "local bundle installed", map[string]any{"bundle": path, "server_version": version.Server, "dest": dest})
	studioSay("installed %s from %s at %s; current -> %s", version.Server, path, dest, dest)
	if !yes && !confirm(fmt.Sprintf("Restart the services now to run %s? This interrupts running agents. [y/N] ", version.Server)) {
		studioSay("not restarted; the services keep running until `ion studio restart`")
		return
	}
	studioRestart(l)
}

// extractStudioBundle writes the tarball to versions/<ver> via the system
// tar (the same tool the installer uses, so both paths produce identical
// trees, including node-pty's executable spawn-helper).
func extractStudioBundle(l studioLayout, ver string, data []byte) (string, error) {
	dest := filepath.Join(l.versions, ver)
	staging := dest + ".partial"
	if err := os.RemoveAll(staging); err != nil {
		return "", err
	}
	if err := os.MkdirAll(staging, 0o755); err != nil {
		return "", err
	}
	tarball := filepath.Join(staging, "bundle.tar.gz")
	if err := os.WriteFile(tarball, data, 0o600); err != nil {
		return "", err
	}
	if out, code, err := (execRunner{}).Run("tar", "-xzf", tarball, "-C", staging, "--strip-components=1"); err != nil || code != 0 {
		return "", fmt.Errorf("tar: %s", firstNonEmpty(out, errString(err)))
	}
	if err := os.Remove(tarball); err != nil {
		return "", err
	}
	if _, err := readBundleVersion(staging); err != nil {
		return "", fmt.Errorf("extracted bundle has no readable VERSION: %w", err)
	}
	if err := os.RemoveAll(dest); err != nil {
		return "", err
	}
	if err := os.Rename(staging, dest); err != nil {
		return "", err
	}
	return dest, nil
}

// repointCurrent swaps the `current` symlink atomically (symlink to a temp
// name, then rename over the old one).
func repointCurrent(l studioLayout, dest string) error {
	tmp := l.current + ".new"
	if err := os.RemoveAll(tmp); err != nil {
		return err
	}
	if err := os.Symlink(dest, tmp); err != nil {
		return err
	}
	if err := os.Rename(tmp, l.current); err != nil {
		return err
	}
	utils.LogWithFields(utils.LevelInfo, studioTag, "current repointed", map[string]any{"current": l.current, "target": dest})
	return nil
}

func confirm(prompt string) bool {
	fmt.Print(prompt)
	reader := bufio.NewReader(os.Stdin)
	line, err := reader.ReadString('\n')
	if err != nil && !errors.Is(err, os.ErrClosed) && line == "" {
		return false
	}
	line = strings.ToLower(strings.TrimSpace(line))
	return line == "y" || line == "yes"
}

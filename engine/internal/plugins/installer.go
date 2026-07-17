package plugins

import (
	"archive/zip"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Install downloads and installs a plugin from a GitHub source ("owner/repo").
// Returns the InstalledPlugin record on success.
func Install(source string, progress func(string)) (InstalledPlugin, error) {
	parts := strings.SplitN(source, "/", 2)
	if len(parts) != 2 || parts[0] == "" || parts[1] == "" {
		return InstalledPlugin{}, fmt.Errorf("invalid plugin source %q: expected owner/repo", source)
	}
	owner, repo := parts[0], parts[1]

	if progress != nil {
		progress("Fetching " + source + "...")
	}

	// Resolve current SHA.
	sha, err := resolveGitHubSHA(owner, repo)
	if err != nil {
		return InstalledPlugin{}, fmt.Errorf("resolve SHA: %w", err)
	}
	shortSHA := sha
	if len(sha) > 12 {
		shortSHA = sha[:12]
	}

	home, _ := os.UserHomeDir()
	installPath := filepath.Join(home, ".ion", "plugins", "cache", owner, repo, shortSHA)

	// Already installed at this SHA?
	if _, statErr := os.Stat(filepath.Join(installPath, ".claude-plugin", "plugin.json")); statErr == nil {
		utils.LogWithFields(utils.LevelInfo, "plugins", "plugin already at sha", map[string]any{
			"source": source, "sha": shortSHA,
		})
	} else {
		if progress != nil {
			progress("Downloading " + source + "...")
		}
		if err := downloadAndExtract(owner, repo, installPath); err != nil {
			return InstalledPlugin{}, fmt.Errorf("download: %w", err)
		}
	}

	// Validate manifest.
	manifest, err := LoadManifest(installPath)
	if err != nil {
		return InstalledPlugin{}, fmt.Errorf("load manifest: %w", err)
	}
	if manifest == nil {
		return InstalledPlugin{}, fmt.Errorf("plugin %s has no .claude-plugin/plugin.json", source)
	}

	name := manifest.Name
	if name == "" {
		name = repo
	}

	p := InstalledPlugin{
		Name:        name,
		Source:      source,
		InstallPath: installPath,
		Version:     shortSHA,
		InstalledAt: time.Now().UTC(),
	}

	if err := Register(p); err != nil {
		return InstalledPlugin{}, fmt.Errorf("register: %w", err)
	}

	utils.LogWithFields(utils.LevelInfo, "plugins", "installed plugin", map[string]any{
		"name": name, "source": source, "sha": shortSHA, "path": installPath,
	})
	return p, nil
}

// resolveGitHubSHA fetches the current HEAD SHA for owner/repo from the GitHub API.
func resolveGitHubSHA(owner, repo string) (string, error) {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/commits/main", owner, repo)
	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		return "", err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("GitHub API %s: %s", url, resp.Status)
	}
	var result struct {
		SHA string `json:"sha"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.SHA == "" {
		return "", fmt.Errorf("empty SHA from GitHub API")
	}
	return result.SHA, nil
}

// downloadAndExtract downloads the repo zipball and extracts it to dest.
func downloadAndExtract(owner, repo, dest string) error {
	url := fmt.Sprintf("https://api.github.com/repos/%s/%s/zipball/main", owner, repo)
	resp, err := http.Get(url) //nolint:noctx
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	if resp.StatusCode != 200 {
		return fmt.Errorf("download %s: %s", url, resp.Status)
	}

	// Write to temp file.
	tmp, err := os.CreateTemp("", "ion-plugin-*.zip")
	if err != nil {
		return err
	}
	defer func() { _ = os.Remove(tmp.Name()) }()
	if _, err := io.Copy(tmp, resp.Body); err != nil {
		_ = tmp.Close()
		return err
	}
	if err := tmp.Close(); err != nil {
		return err
	}

	// Extract.
	if err := os.MkdirAll(dest, 0o755); err != nil {
		return err
	}
	return extractZip(tmp.Name(), dest)
}

// extractZip extracts a GitHub zipball to dest. GitHub zipballs have a single
// top-level directory (e.g. "owner-repo-sha/"); we strip it when extracting.
func extractZip(zipPath, dest string) error {
	r, err := zip.OpenReader(zipPath)
	if err != nil {
		return err
	}
	defer func() { _ = r.Close() }()

	// Find the top-level prefix (first directory component).
	prefix := ""
	for _, f := range r.File {
		if idx := strings.Index(f.Name, "/"); idx > 0 {
			prefix = f.Name[:idx+1]
			break
		}
	}

	for _, f := range r.File {
		// Strip the top-level GitHub directory prefix.
		name := f.Name
		if prefix != "" {
			name = strings.TrimPrefix(name, prefix)
		}
		if name == "" {
			continue
		}

		target := filepath.Join(dest, filepath.FromSlash(name))

		// Guard against zip-slip.
		if !strings.HasPrefix(filepath.Clean(target)+string(os.PathSeparator), filepath.Clean(dest)+string(os.PathSeparator)) {
			return fmt.Errorf("zip slip detected: %s", f.Name)
		}

		if f.FileInfo().IsDir() {
			if err := os.MkdirAll(target, 0o755); err != nil {
				return err
			}
			continue
		}

		if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
			return err
		}

		out, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, f.Mode())
		if err != nil {
			return err
		}
		rc, err := f.Open()
		if err != nil {
			_ = out.Close()
			return err
		}
		_, copyErr := io.Copy(out, rc)
		_ = rc.Close()
		if closeErr := out.Close(); closeErr != nil && copyErr == nil {
			copyErr = closeErr
		}
		if copyErr != nil {
			return copyErr
		}
	}
	return nil
}

// Remove uninstalls a plugin by name: unregisters and deletes the install directory.
func Remove(name string) error {
	plugins, err := ListInstalled()
	if err != nil {
		return err
	}
	var installPath string
	for _, p := range plugins {
		if p.Name == name {
			installPath = p.InstallPath
			break
		}
	}
	if installPath == "" {
		return fmt.Errorf("plugin %q not found", name)
	}
	if err := Unregister(name); err != nil {
		return err
	}
	if err := os.RemoveAll(installPath); err != nil {
		utils.LogWithFields(utils.LevelInfo, "plugins", "failed to remove install dir", map[string]any{
			"name": name, "path": installPath, "error": err.Error(),
		})
	}
	utils.LogWithFields(utils.LevelInfo, "plugins", "removed plugin", map[string]any{
		"name": name, "path": installPath,
	})
	return nil
}

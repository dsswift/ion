package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"time"
)

const (
	githubRepo   = "dsswift/ion"
	releaseTag   = "engine-v"
	upgradeAgent = "ion-engine-upgrade"
)

func cmdUpgrade() {
	if version == "dev" {
		fmt.Fprintln(os.Stderr, "Cannot upgrade a development build. Install a release build first.")
		os.Exit(1)
	}

	fmt.Println("Checking for updates...")

	latest, downloadURL, err := findLatestRelease()
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error checking for updates: %s\n", err)
		os.Exit(1)
	}

	if latest == version {
		fmt.Printf("Already up to date: %s\n", version)
		return
	}

	fmt.Printf("Update available: %s → %s\n", version, latest)

	checksums, err := fetchChecksums(latest)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error fetching checksums: %s\n", err)
		os.Exit(1)
	}

	assetName := assetFilename()
	expectedHash, ok := checksums[assetName]
	if !ok {
		fmt.Fprintf(os.Stderr, "No checksum found for %s\n", assetName)
		os.Exit(1)
	}

	fmt.Printf("Downloading %s...\n", assetName)
	data, err := downloadAsset(downloadURL)
	if err != nil {
		fmt.Fprintf(os.Stderr, "Error downloading: %s\n", err)
		os.Exit(1)
	}

	actualHash := sha256sum(data)
	if actualHash != expectedHash {
		fmt.Fprintf(os.Stderr, "Checksum mismatch!\n  expected: %s\n  actual:   %s\n", expectedHash, actualHash)
		os.Exit(1)
	}
	fmt.Println("Checksum verified.")

	if err := replaceBinary(data); err != nil {
		fmt.Fprintf(os.Stderr, "Error replacing binary: %s\n", err)
		os.Exit(1)
	}

	fmt.Printf("Upgraded: %s → %s\n", version, latest)
}

// findLatestRelease queries GitHub for the latest engine release and returns
// the version string and the download URL for the current platform binary.
func findLatestRelease() (ver string, url string, err error) {
	apiURL := fmt.Sprintf("https://api.github.com/repos/%s/releases", githubRepo)
	req, err := http.NewRequest("GET", apiURL, nil)
	if err != nil {
		return "", "", err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	req.Header.Set("User-Agent", upgradeAgent)

	client := &http.Client{Timeout: 15 * time.Second}
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

	target := assetFilename()
	for _, r := range releases {
		if !strings.HasPrefix(r.TagName, releaseTag) || r.Draft || r.Prerelease {
			continue
		}
		v := strings.TrimPrefix(r.TagName, releaseTag)
		for _, a := range r.Assets {
			if a.Name == target {
				return v, a.DownloadURL, nil
			}
		}
	}
	return "", "", fmt.Errorf("no release found for %s", target)
}

// fetchChecksums downloads and parses checksums.txt from the given release.
func fetchChecksums(ver string) (map[string]string, error) {
	url := fmt.Sprintf(
		"https://github.com/%s/releases/download/%s%s/checksums.txt",
		githubRepo, releaseTag, ver,
	)
	data, err := downloadAsset(url)
	if err != nil {
		return nil, err
	}

	result := make(map[string]string)
	for _, line := range strings.Split(string(data), "\n") {
		line = strings.TrimSpace(line)
		if line == "" {
			continue
		}
		// Format: "<hash>  ./<filename>" or "<hash>  <filename>"
		parts := strings.Fields(line)
		if len(parts) != 2 {
			continue
		}
		name := strings.TrimPrefix(parts[1], "./")
		result[name] = parts[0]
	}
	return result, nil
}

func downloadAsset(url string) ([]byte, error) {
	req, err := http.NewRequest("GET", url, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Accept", "application/octet-stream")
	req.Header.Set("User-Agent", upgradeAgent)

	client := &http.Client{Timeout: 120 * time.Second}
	resp, err := client.Do(req)
	if err != nil {
		return nil, err
	}
	defer func() { resp.Body.Close() }() //nolint:errcheck // deferred close on read-only HTTP response body

	if resp.StatusCode != http.StatusOK {
		return nil, fmt.Errorf("download returned %d", resp.StatusCode)
	}
	return io.ReadAll(resp.Body)
}

func sha256sum(data []byte) string {
	h := sha256.Sum256(data)
	return hex.EncodeToString(h[:])
}

// replaceBinary atomically replaces the running executable with new data.
func replaceBinary(data []byte) error {
	exe, err := os.Executable()
	if err != nil {
		return fmt.Errorf("locate executable: %w", err)
	}
	exe, err = filepath.EvalSymlinks(exe)
	if err != nil {
		return fmt.Errorf("resolve symlinks: %w", err)
	}

	info, err := os.Stat(exe)
	if err != nil {
		return fmt.Errorf("stat executable: %w", err)
	}

	// Write to a temp file in the same directory (same filesystem for rename).
	dir := filepath.Dir(exe)
	tmp, err := os.CreateTemp(dir, ".ion-upgrade-*")
	if err != nil {
		return fmt.Errorf("create temp file: %w", err)
	}
	tmpPath := tmp.Name()

	if _, err := tmp.Write(data); err != nil {
		tmp.Close()        //nolint:errcheck // closing before removing the failed temp file
		os.Remove(tmpPath) //nolint:errcheck // best-effort cleanup of failed temp file
		return fmt.Errorf("write temp file: %w", err)
	}
	if err := tmp.Close(); err != nil {
		os.Remove(tmpPath) //nolint:errcheck // best-effort cleanup of failed temp file
		return fmt.Errorf("close temp file: %w", err)
	}

	if err := os.Chmod(tmpPath, info.Mode()); err != nil {
		os.Remove(tmpPath) //nolint:errcheck // best-effort cleanup of failed temp file
		return fmt.Errorf("chmod: %w", err)
	}

	if err := os.Rename(tmpPath, exe); err != nil {
		os.Remove(tmpPath) //nolint:errcheck // best-effort cleanup of failed temp file
		return fmt.Errorf("rename: %w", err)
	}
	return nil
}

// assetFilename returns the expected release asset name for this platform.
func assetFilename() string {
	ext := ""
	if runtime.GOOS == "windows" {
		ext = ".exe"
	}
	return fmt.Sprintf("ion-%s-%s%s", runtime.GOOS, runtime.GOARCH, ext)
}

// ghRelease is the minimal GitHub release JSON shape we need.
type ghRelease struct {
	TagName    string    `json:"tag_name"`
	Draft      bool      `json:"draft"`
	Prerelease bool      `json:"prerelease"`
	Assets     []ghAsset `json:"assets"`
}

type ghAsset struct {
	Name        string `json:"name"`
	DownloadURL string `json:"browser_download_url"`
}

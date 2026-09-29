package fleet

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// ReleasesURL lists Ion's GitHub releases. A var so tests can point it at a
// fake.
var ReleasesURL = "https://api.github.com/repos/dsswift/ion/releases?per_page=50"

// Release tag prefixes.
const (
	serverTagPrefix  = "server-v"
	desktopTagPrefix = "desktop-v"
)

// Latest is the newest published Studio Server and desktop versions.
type Latest struct {
	Server  string `json:"server,omitempty"`
	Desktop string `json:"desktop,omitempty"`
	// ServerAssets and DesktopAssets are the newest releases' downloadable files.
	ServerAssets  []ReleaseAsset `json:"-"`
	DesktopAssets []ReleaseAsset `json:"-"`
}

// ReleaseAsset is one downloadable file of a release.
type ReleaseAsset struct {
	Name string `json:"name"`
	URL  string `json:"browser_download_url"`
	// Digest is GitHub's "sha256:<hex>" for the file.
	Digest string `json:"digest"`
}

type githubRelease struct {
	Tag        string         `json:"tag_name"`
	Draft      bool           `json:"draft"`
	Prerelease bool           `json:"prerelease"`
	Assets     []ReleaseAsset `json:"assets"`
}

// LatestReleases reads the release list once for both products.
func LatestReleases(ctx context.Context) (Latest, error) {
	var l Latest
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, ReleasesURL, nil)
	if err != nil {
		return l, err
	}
	req.Header.Set("Accept", "application/vnd.github+json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return l, fmt.Errorf("list releases: %w", err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	if resp.StatusCode != http.StatusOK {
		return l, fmt.Errorf("list releases: HTTP %d", resp.StatusCode)
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 16<<20))
	if err != nil {
		return l, err
	}
	var releases []githubRelease
	if err := json.Unmarshal(data, &releases); err != nil {
		return l, fmt.Errorf("parse releases: %w", err)
	}
	for _, r := range releases {
		if r.Draft || r.Prerelease {
			continue
		}
		switch {
		case l.Server == "" && strings.HasPrefix(r.Tag, serverTagPrefix):
			l.Server = strings.TrimPrefix(r.Tag, serverTagPrefix)
			l.ServerAssets = r.Assets
		case l.Desktop == "" && strings.HasPrefix(r.Tag, desktopTagPrefix):
			l.Desktop = strings.TrimPrefix(r.Tag, desktopTagPrefix)
			l.DesktopAssets = r.Assets
		}
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "latest releases", map[string]any{"server": l.Server, "desktop": l.Desktop})
	return l, nil
}

package plugins

import (
	"fmt"
	"net/url"
	"regexp"
	"strings"
)

// Source is where a plugin comes from. ID names it in the registry and is
// what plugin policy (allowlist, denylist, force-installs) matches on: a
// GitHub repository is "owner/repo" however it was written, any other git
// host is "host/path". URLs are the git remotes to fetch it from, tried in
// order.
type Source struct {
	ID   string
	URLs []string
}

var (
	shorthand  = regexp.MustCompile(`^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$`)
	scpRemote  = regexp.MustCompile(`^[A-Za-z0-9_.-]+@([A-Za-z0-9_.-]+):(.+)$`)
	pathOfRepo = regexp.MustCompile(`^[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)+$`)
)

// ParseSource reads a plugin source as a person writes it: "owner/repo" for
// GitHub, or any git remote ("git@github.com:owner/repo.git",
// "https://gitlab.example.com/group/repo.git", "ssh://..."). A GitHub
// shorthand is fetched over HTTPS first and SSH second, so a public
// repository needs no credentials and a private one uses whichever the
// person's git already has.
func ParseSource(s string) (Source, error) {
	s = strings.TrimSpace(s)
	if shorthand.MatchString(s) && !strings.Contains(s, "..") {
		return Source{ID: s, URLs: []string{"https://github.com/" + s + ".git", "git@github.com:" + s + ".git"}}, nil
	}
	host, repoPath, err := remoteParts(s)
	if err != nil {
		return Source{}, fmt.Errorf("invalid plugin source %q: expected owner/repo or a git URL", s)
	}
	repoPath = strings.TrimSuffix(strings.Trim(repoPath, "/"), ".git")
	if !pathOfRepo.MatchString(repoPath) || strings.Contains(repoPath, "..") {
		return Source{}, fmt.Errorf("invalid plugin source %q: no repository path in the URL", s)
	}
	id := strings.ToLower(host) + "/" + repoPath
	if strings.EqualFold(host, "github.com") {
		id = repoPath
	}
	return Source{ID: id, URLs: []string{s}}, nil
}

func remoteParts(s string) (host, repoPath string, err error) {
	if m := scpRemote.FindStringSubmatch(s); m != nil && !strings.Contains(s, "://") {
		return m[1], m[2], nil
	}
	u, err := url.Parse(s)
	if err != nil || u.Host == "" {
		return "", "", fmt.Errorf("not a git remote")
	}
	switch u.Scheme {
	case "https", "http", "ssh", "git":
		return u.Hostname(), u.Path, nil
	}
	return "", "", fmt.Errorf("unsupported scheme %q", u.Scheme)
}

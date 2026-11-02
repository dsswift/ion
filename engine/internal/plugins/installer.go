package plugins

import (
	"bytes"
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Install fetches a Claude Code-compatible plugin with git and registers it.
// source is "owner/repo" or a git URL (see ParseSource); git signs in with
// whatever credentials the person's git already uses, so a private
// repository installs like a public one. plugin picks one plugin from a
// repository whose .claude-plugin/marketplace.json lists several; empty
// takes the repository's own plugin, or the marketplace's only one.
//
// Installing what is already installed fetches its current commit, so the
// same call updates it. Returns the InstalledPlugin record on success.
func Install(source, plugin string, progress func(string)) (InstalledPlugin, error) {
	src, err := ParseSource(source)
	if err != nil {
		return InstalledPlugin{}, err
	}
	return install(src, plugin, progress)
}

func install(src Source, plugin string, progress func(string)) (InstalledPlugin, error) {
	say := func(msg string) {
		if progress != nil {
			progress(msg)
		}
	}

	say("Fetching " + src.ID + "...")
	remote, sha, err := resolveHead(src.URLs)
	if err != nil {
		return InstalledPlugin{}, err
	}
	cache := filepath.Join(utils.IonDir(), "plugins", "cache", filepath.FromSlash(src.ID))
	checkout := filepath.Join(cache, sha[:12])

	if _, statErr := os.Stat(checkout); statErr == nil {
		utils.LogWithFields(utils.LevelInfo, "plugins", "plugin already at sha", map[string]any{
			"source": src.ID, "sha": sha[:12],
		})
	} else {
		say("Downloading " + src.ID + "...")
		if checkout, err = clone(remote, cache); err != nil {
			return InstalledPlugin{}, err
		}
	}
	shortSHA := filepath.Base(checkout)

	dir, manifest, err := pickPlugin(checkout, plugin)
	if err != nil {
		return InstalledPlugin{}, err
	}
	name := manifest.Name
	if name == "" {
		name = filepath.Base(dir)
	}

	p := InstalledPlugin{
		Name:         name,
		Source:       src.ID,
		URL:          remote,
		Plugin:       plugin,
		InstallPath:  dir,
		CheckoutPath: checkout,
		Version:      shortSHA,
		InstalledAt:  time.Now().UTC(),
	}

	previous, _ := find(name) //nolint:errcheck // a missing registry means nothing to replace
	if err := Register(p); err != nil {
		return InstalledPlugin{}, fmt.Errorf("register: %w", err)
	}
	if previous != nil && previous.Source == p.Source && previous.root() != p.root() {
		removeUnused(previous.root())
	}

	utils.LogWithFields(utils.LevelInfo, "plugins", "installed plugin", map[string]any{
		"name": name, "source": src.ID, "sha": shortSHA, "path": dir,
	})
	return p, nil
}

// Update fetches the current commit of an installed plugin from where it was
// installed. changed reports whether the commit moved.
func Update(name string, progress func(string)) (p InstalledPlugin, changed bool, err error) {
	old, err := find(name)
	if err != nil {
		return InstalledPlugin{}, false, err
	}
	if old == nil {
		return InstalledPlugin{}, false, fmt.Errorf("plugin %q not found", name)
	}
	src := Source{ID: old.Source, URLs: []string{old.URL}}
	if old.URL == "" {
		if src, err = ParseSource(old.Source); err != nil {
			return InstalledPlugin{}, false, err
		}
	}
	p, err = install(src, old.Plugin, progress)
	if err != nil {
		return InstalledPlugin{}, false, err
	}
	return p, p.Version != old.Version, nil
}

// gitEnv keeps git from waiting on a prompt nobody can answer: a missing
// credential fails the fetch instead of hanging it.
func gitEnv() []string {
	env := append(os.Environ(), "GIT_TERMINAL_PROMPT=0")
	if os.Getenv("GIT_SSH_COMMAND") == "" {
		env = append(env, "GIT_SSH_COMMAND=ssh -o BatchMode=yes")
	}
	return env
}

func git(args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Env = gitEnv()
	var stdout, stderr bytes.Buffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	if err := cmd.Run(); err != nil {
		if _, lookErr := exec.LookPath("git"); lookErr != nil {
			return "", fmt.Errorf("installing a plugin needs git on the PATH")
		}
		msg := strings.TrimSpace(stderr.String())
		if msg == "" {
			msg = err.Error()
		}
		return "", fmt.Errorf("git %s: %s", args[0], msg)
	}
	return strings.TrimSpace(stdout.String()), nil
}

// resolveHead returns the first remote that answers and its HEAD commit.
func resolveHead(remotes []string) (remote, sha string, err error) {
	var failures []string
	for _, r := range remotes {
		out, err := git("ls-remote", r, "HEAD")
		if err != nil {
			failures = append(failures, err.Error())
			continue
		}
		fields := strings.Fields(out)
		if len(fields) == 0 || len(fields[0]) < 12 {
			failures = append(failures, r+": no HEAD commit")
			continue
		}
		return r, fields[0], nil
	}
	return "", "", fmt.Errorf("cannot reach the plugin repository: %s", strings.Join(failures, "; "))
}

// clone puts a shallow copy of remote's HEAD in cache/<sha12>, without its
// .git directory, and returns that directory. It clones beside it and
// renames, so the directory is never half there, and names it by the commit
// it actually got.
func clone(remote, cache string) (string, error) {
	if err := os.MkdirAll(cache, 0o755); err != nil {
		return "", err
	}
	tmp, err := os.MkdirTemp(cache, ".clone-*")
	if err != nil {
		return "", err
	}
	defer func() { os.RemoveAll(tmp) }() //nolint:errcheck // temp cleanup
	work := filepath.Join(tmp, "repo")
	if _, err := git("clone", "--depth", "1", "--quiet", remote, work); err != nil {
		return "", err
	}
	sha, err := git("-C", work, "rev-parse", "HEAD")
	if err != nil {
		return "", err
	}
	dest := filepath.Join(cache, sha[:12])
	if _, err := os.Stat(dest); err == nil {
		return dest, nil
	}
	if err := os.RemoveAll(filepath.Join(work, ".git")); err != nil {
		return "", err
	}
	return dest, os.Rename(work, dest)
}

// marketplace is the part of .claude-plugin/marketplace.json Ion reads: each
// plugin's name and where it sits in the repository.
type marketplace struct {
	Plugins []struct {
		Name   string          `json:"name"`
		Source json.RawMessage `json:"source"`
	} `json:"plugins"`
}

// pickPlugin finds the plugin directory in a checkout: the repository's own
// plugin (.claude-plugin/plugin.json at the root), or one its marketplace
// lists by a path inside the repository.
func pickPlugin(checkout, want string) (string, *PluginManifest, error) {
	root, err := LoadManifest(checkout)
	if err != nil {
		return "", nil, err
	}
	if root != nil && (want == "" || want == root.Name) {
		return checkout, root, nil
	}

	data, err := os.ReadFile(filepath.Join(checkout, ".claude-plugin", "marketplace.json"))
	if err != nil {
		if os.IsNotExist(err) {
			if want != "" {
				return "", nil, fmt.Errorf("the repository has no plugin %q", want)
			}
			return "", nil, fmt.Errorf("the repository has no .claude-plugin/plugin.json or marketplace.json")
		}
		return "", nil, err
	}
	var m marketplace
	if err := json.Unmarshal(data, &m); err != nil {
		return "", nil, fmt.Errorf("parse marketplace.json: %w", err)
	}
	names := make([]string, 0, len(m.Plugins))
	for _, entry := range m.Plugins {
		names = append(names, entry.Name)
	}
	sort.Strings(names)

	for _, entry := range m.Plugins {
		if want != "" && entry.Name != want {
			continue
		}
		if want == "" && len(m.Plugins) > 1 {
			return "", nil, fmt.Errorf("the repository lists several plugins (%s); name the one to install", strings.Join(names, ", "))
		}
		var rel string
		if err := json.Unmarshal(entry.Source, &rel); err != nil {
			return "", nil, fmt.Errorf("plugin %q lives in another repository; install it from there", entry.Name)
		}
		dir := filepath.Join(checkout, filepath.FromSlash(rel))
		if !strings.HasPrefix(dir+string(os.PathSeparator), checkout+string(os.PathSeparator)) {
			return "", nil, fmt.Errorf("plugin %q points outside its repository", entry.Name)
		}
		manifest, err := LoadManifest(dir)
		if err != nil {
			return "", nil, err
		}
		if manifest == nil {
			return "", nil, fmt.Errorf("plugin %q has no .claude-plugin/plugin.json", entry.Name)
		}
		if manifest.Name == "" {
			manifest.Name = entry.Name
		}
		return dir, manifest, nil
	}
	return "", nil, fmt.Errorf("the repository has no plugin %q; it lists %s", want, strings.Join(names, ", "))
}

func find(name string) (*InstalledPlugin, error) {
	installed, err := ListInstalled()
	if err != nil {
		return nil, err
	}
	for _, p := range installed {
		if p.Name == name {
			return &p, nil
		}
	}
	return nil, nil
}

// removeUnused deletes a checkout no registered plugin still lives in.
func removeUnused(dir string) {
	installed, err := ListInstalled()
	if err != nil {
		return
	}
	for _, p := range installed {
		if p.root() == dir {
			return
		}
	}
	if err := os.RemoveAll(dir); err != nil {
		utils.LogWithFields(utils.LevelInfo, "plugins", "failed to remove install dir", map[string]any{
			"path": dir, "error": err.Error(),
		})
	}
}

// Remove uninstalls a plugin by name: unregisters it and deletes its checkout
// once no other plugin lives in it.
func Remove(name string) error {
	p, err := find(name)
	if err != nil {
		return err
	}
	if p == nil {
		return fmt.Errorf("plugin %q not found", name)
	}
	if err := Unregister(name); err != nil {
		return err
	}
	removeUnused(p.root())
	utils.LogWithFields(utils.LevelInfo, "plugins", "removed plugin", map[string]any{
		"name": name, "path": p.InstallPath,
	})
	return nil
}

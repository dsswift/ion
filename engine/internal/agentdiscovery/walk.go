package agentdiscovery

import (
	"os"
	"path/filepath"
	"strings"
)

// WalkAgentFiles returns absolute paths to .md files in the directories
// specified by opts. Project dir entries win over user dir entries with
// the same filename stem (dedup by stem, first seen wins).
func WalkAgentFiles(opts WalkOptions) ([]string, error) {
	// Build ordered directory list. Project dirs come first so they win dedup.
	var dirs []string

	if opts.IncludeProjectDir {
		cwd, err := os.Getwd()
		if err == nil {
			dirs = append(dirs, filepath.Join(cwd, ".ion", "agents"))
		}
	}

	if opts.IncludeUserDir {
		home, err := os.UserHomeDir()
		if err == nil {
			dirs = append(dirs, filepath.Join(home, ".ion", "agents"))
		}
	}

	dirs = append(dirs, opts.ExtraDirs...)

	seen := make(map[string]bool)  // stem -> already collected
	var paths []string

	for _, dir := range dirs {
		info, err := os.Stat(dir)
		if err != nil || !info.IsDir() {
			continue // skip missing dirs
		}

		err = filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
			if err != nil {
				return nil // skip unreadable entries
			}
			if d.IsDir() {
				// If non-recursive, skip subdirectories (but not root)
				if !opts.Recursive && p != dir {
					return filepath.SkipDir
				}
				return nil
			}
			if !strings.HasSuffix(d.Name(), ".md") {
				return nil
			}
			stem := stemFromPath(p)
			if seen[stem] {
				return nil // dedup: first dir wins
			}
			seen[stem] = true
			abs, _ := filepath.Abs(p)
			paths = append(paths, abs)
			return nil
		})
		if err != nil {
			return nil, err
		}
	}

	return paths, nil
}

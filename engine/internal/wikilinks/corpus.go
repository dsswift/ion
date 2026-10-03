package wikilinks

import (
	"errors"
	"io/fs"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"github.com/dsswift/ion/engine/internal/utils"
)

// Options scopes one operation to a workspace.
type Options struct {
	// Root is the workspace root. Nothing outside it is read or written.
	Root string
	// Ignore reports whether a root-relative, forward-slash path is excluded.
	// An ignored directory is not descended into. Nil admits everything.
	Ignore func(rel string, isDir bool) bool
	// Extensions lists the document extensions, lower case with a leading
	// dot. Only documents are scanned for links.
	Extensions []string
}

func (o Options) isDocument(rel string) bool {
	lower := strings.ToLower(rel)
	for _, ext := range o.Extensions {
		if strings.HasSuffix(lower, ext) {
			return true
		}
	}
	return false
}

// listFiles returns the root-relative path of every regular, non-ignored file
// under the root, in lexical order. Directory entries are read without
// following symbolic links, so a link that points outside the root is never
// listed.
func listFiles(opts Options) (root string, files []string, err error) {
	if opts.Root == "" {
		return "", nil, errors.New("wikilinks: root is empty")
	}
	root, err = filepath.Abs(opts.Root)
	if err != nil {
		return "", nil, err
	}
	err = filepath.WalkDir(root, func(p string, d fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			if p == root {
				return walkErr
			}
			utils.LogWithFields(utils.LevelDebug, "wikilinks", "walk entry skipped", map[string]any{"path": p, "error": walkErr.Error()})
			if d != nil && d.IsDir() {
				return filepath.SkipDir
			}
			return nil
		}
		if p == root {
			return nil
		}
		relOS, relErr := filepath.Rel(root, p)
		if relErr != nil {
			return nil
		}
		rel := filepath.ToSlash(relOS)
		if d.IsDir() {
			if opts.Ignore != nil && opts.Ignore(rel, true) {
				return filepath.SkipDir
			}
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if opts.Ignore != nil && opts.Ignore(rel, false) {
			return nil
		}
		files = append(files, rel)
		return nil
	})
	if err != nil {
		return "", nil, err
	}
	return root, files, nil
}

// corpus is the set of files a link can resolve against.
type corpus struct {
	exts   []string
	files  map[string]struct{}
	byName map[string][]string
}

func newCorpus(files []string, exts []string) *corpus {
	c := &corpus{
		exts:   exts,
		files:  make(map[string]struct{}, len(files)),
		byName: make(map[string][]string, len(files)),
	}
	for _, rel := range files {
		c.files[rel] = struct{}{}
		name := strings.ToLower(path.Base(rel))
		c.byName[name] = append(c.byName[name], rel)
		// A document also answers to its name without the extension.
		if stem, ok := c.trimDocExt(name); ok {
			c.byName[stem] = append(c.byName[stem], rel)
		}
	}
	return c
}

// trimDocExt strips a document extension from s, compared case-insensitively.
func (c *corpus) trimDocExt(s string) (string, bool) {
	lower := strings.ToLower(s)
	for _, ext := range c.exts {
		if strings.HasSuffix(lower, ext) && len(s) > len(ext) {
			return s[:len(s)-len(ext)], true
		}
	}
	return s, false
}

// How a target was matched to a file.
const (
	viaNone    = iota
	viaAbs     // a leading "/" anchored it at the root
	viaFromDir // a path relative to the linking file's directory
	viaRoot    // a path relative to the root
	viaName    // a bare file name, unique in the corpus
)

type resolution struct {
	// path is the file the target names; empty when it names none.
	path string
	via  int
	// candidates holds the files an ambiguous bare name could mean.
	candidates []string
}

func (r resolution) resolved() bool { return r.path != "" }

// resolve finds the file a link target names, for a link written in the file
// at from. In order: a path from the root when the target starts with "/"; a
// path relative to the linking file's directory; a path relative to the root;
// then a bare file name, matched case-insensitively and only when exactly one
// file carries it. A path may omit a document extension.
func (c *corpus) resolve(target, from string) resolution {
	target = strings.ReplaceAll(target, "\\", "/")
	if strings.HasPrefix(target, "/") {
		if hit := c.lookup(strings.TrimLeft(target, "/")); hit != "" {
			return resolution{path: hit, via: viaAbs}
		}
		return resolution{}
	}

	fromDir := path.Dir(from)
	if fromDir == "." {
		fromDir = ""
	}
	if hit := c.lookup(path.Join(fromDir, target)); hit != "" {
		return resolution{path: hit, via: viaFromDir}
	}
	explicitRelative := strings.HasPrefix(target, "./") || strings.HasPrefix(target, "../")
	if !explicitRelative && fromDir != "" {
		if hit := c.lookup(target); hit != "" {
			return resolution{path: hit, via: viaRoot}
		}
	}

	if strings.Contains(target, "/") {
		return resolution{}
	}
	matches := c.byName[strings.ToLower(target)]
	switch len(matches) {
	case 0:
		return resolution{}
	case 1:
		return resolution{path: matches[0], via: viaName}
	default:
		candidates := append([]string(nil), matches...)
		sort.Strings(candidates)
		return resolution{candidates: candidates}
	}
}

// lookup matches a root-relative path against the corpus, with or without a
// document extension. A path that climbs above the root matches nothing.
func (c *corpus) lookup(rel string) string {
	rel = path.Clean(rel)
	if rel == "." || rel == ".." || strings.HasPrefix(rel, "../") || strings.HasPrefix(rel, "/") {
		return ""
	}
	if _, ok := c.files[rel]; ok {
		return rel
	}
	for _, ext := range c.exts {
		if _, ok := c.files[rel+ext]; ok {
			return rel + ext
		}
	}
	return ""
}

// retarget returns the target text that makes a link written in from name the
// file dest, keeping the style of the link's previous target: a bare name
// stays a bare name, a path stays a path, an extension stays written. It
// falls back to a path from the root when the preferred style would not name
// dest unambiguously. Returns false when no form resolves to dest.
func (c *corpus) retarget(oldTarget string, oldVia int, dest, from string) (string, bool) {
	oldTarget = strings.ReplaceAll(oldTarget, "\\", "/")
	fromDir := path.Dir(from)
	if fromDir == "." {
		fromDir = ""
	}

	destName := dest
	if _, hadExt := c.trimDocExt(oldTarget); !hadExt {
		destName, _ = c.trimDocExt(dest)
	}
	absolute := "/" + destName

	var forms []string
	switch {
	case strings.HasPrefix(oldTarget, "/"):
		// Already anchored at the root: only the anchored form keeps the style.
	case strings.HasPrefix(oldTarget, "./") || strings.HasPrefix(oldTarget, "../"):
		forms = append(forms, dotRelative(fromDir, destName), destName)
	case !strings.Contains(oldTarget, "/"):
		forms = append(forms, path.Base(destName), destName)
	case oldVia == viaFromDir:
		if fromDir != "" && strings.HasPrefix(destName, fromDir+"/") {
			forms = append(forms, strings.TrimPrefix(destName, fromDir+"/"))
		}
		forms = append(forms, destName)
	default:
		forms = append(forms, destName)
	}
	forms = append(forms, absolute)

	for _, form := range forms {
		if c.resolve(form, from).path == dest {
			return form, true
		}
	}
	return "", false
}

// dotRelative returns dest as a path relative to fromDir, always starting
// with "./" or "../".
func dotRelative(fromDir, dest string) string {
	var fromParts []string
	if fromDir != "" {
		fromParts = strings.Split(fromDir, "/")
	}
	destParts := strings.Split(dest, "/")
	common := 0
	for common < len(fromParts) && common < len(destParts)-1 && fromParts[common] == destParts[common] {
		common++
	}
	up := len(fromParts) - common
	if up == 0 {
		return "./" + strings.Join(destParts[common:], "/")
	}
	return strings.Repeat("../", up) + strings.Join(destParts[common:], "/")
}

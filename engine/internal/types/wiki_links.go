package types

import "strings"

// WikiLinksConfig controls the wiki-link maintenance subsystem: rename
// detection in a watched workspace, rewriting `[[target]]` references when a
// document is renamed, and the read-only link integrity scan. Harness
// engineers set it via engine.json's "wikiLinks" block.
//
// Every accessor is nil-safe and returns the compiled default, so callers
// chain cfg.GetWikiLinks().PropagationEnabled() without a nil check.
//
// The fields are pointers so an explicit false survives layered engine.json
// merges; nil means "inherit the default".
type WikiLinksConfig struct {
	// Enabled is the master switch. When false the engine tracks no file
	// identity, detects no renames, rewrites nothing, and refuses the
	// integrity scan without reading the workspace. Default: true.
	Enabled *bool `json:"enabled,omitempty"`

	// PropagateOnRename controls whether a detected rename rewrites inbound
	// wiki links. When false, renames are still detected and reported through
	// the workspace_file_renamed hook, but no file is rewritten. Default: true.
	PropagateOnRename *bool `json:"propagateOnRename,omitempty"`

	// IntegrityScan controls whether the on-demand link integrity scan may
	// run. When false the scan is refused before the workspace is read.
	// Default: true.
	IntegrityScan *bool `json:"integrityScan,omitempty"`

	// Extensions lists the file extensions treated as documents: the files
	// scanned for wiki links and the files whose renames are detected. Entries
	// are matched case-insensitively; a missing leading dot is added.
	// Default: [".md"].
	Extensions []string `json:"extensions,omitempty"`
}

// defaultWikiLinkExtensions is the compiled default document extension list.
var defaultWikiLinkExtensions = []string{".md"}

// IsEnabled reports whether the subsystem is on at all. Default true.
func (c *WikiLinksConfig) IsEnabled() bool {
	return c == nil || c.Enabled == nil || *c.Enabled
}

// PropagationEnabled reports whether a detected rename rewrites inbound
// links. False whenever the master switch is off.
func (c *WikiLinksConfig) PropagationEnabled() bool {
	if !c.IsEnabled() {
		return false
	}
	return c == nil || c.PropagateOnRename == nil || *c.PropagateOnRename
}

// IntegrityScanEnabled reports whether the on-demand integrity scan may run.
// False whenever the master switch is off.
func (c *WikiLinksConfig) IntegrityScanEnabled() bool {
	if !c.IsEnabled() {
		return false
	}
	return c == nil || c.IntegrityScan == nil || *c.IntegrityScan
}

// DocumentExtensions returns the normalized document extension list: lower
// case, leading dot, no blanks, no duplicates. Falls back to the compiled
// default when the configured list is empty.
func (c *WikiLinksConfig) DocumentExtensions() []string {
	if c == nil || len(c.Extensions) == 0 {
		return append([]string(nil), defaultWikiLinkExtensions...)
	}
	seen := make(map[string]bool, len(c.Extensions))
	out := make([]string, 0, len(c.Extensions))
	for _, raw := range c.Extensions {
		ext := strings.ToLower(strings.TrimSpace(raw))
		if ext == "" || ext == "." {
			continue
		}
		if !strings.HasPrefix(ext, ".") {
			ext = "." + ext
		}
		if seen[ext] {
			continue
		}
		seen[ext] = true
		out = append(out, ext)
	}
	if len(out) == 0 {
		return append([]string(nil), defaultWikiLinkExtensions...)
	}
	return out
}

// MergeWikiLinks copies the set fields of src into dst. Both pointers may be
// nil; returns the merged result (or nil if both are nil).
func MergeWikiLinks(dst, src *WikiLinksConfig) *WikiLinksConfig {
	if src == nil {
		return dst
	}
	if dst == nil {
		dup := *src
		dup.Extensions = append([]string(nil), src.Extensions...)
		return &dup
	}
	if src.Enabled != nil {
		dst.Enabled = src.Enabled
	}
	if src.PropagateOnRename != nil {
		dst.PropagateOnRename = src.PropagateOnRename
	}
	if src.IntegrityScan != nil {
		dst.IntegrityScan = src.IntegrityScan
	}
	if len(src.Extensions) > 0 {
		dst.Extensions = append([]string(nil), src.Extensions...)
	}
	return dst
}

// WikiLinkRename is one detected document rename. Both paths are relative to
// the workspace root and forward-slash separated.
type WikiLinkRename struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

// WikiLinkRewrite is one rewritten wiki link.
type WikiLinkRewrite struct {
	// Line is the 1-based line the link sits on.
	Line int `json:"line"`
	// OldLink and NewLink are the full link text, brackets included, before
	// and after the rewrite. An alias and a `#section` suffix are carried
	// over unchanged.
	OldLink string `json:"oldLink"`
	NewLink string `json:"newLink"`
	// OldTarget and NewTarget are the workspace-relative paths of the file
	// the link resolved to before and after the rename.
	OldTarget string `json:"oldTarget"`
	NewTarget string `json:"newTarget"`
}

// WikiLinkFileRewrites lists the links rewritten in one file. Path is
// workspace-relative and names the file as it is after the rename.
type WikiLinkFileRewrites struct {
	Path     string            `json:"path"`
	Rewrites []WikiLinkRewrite `json:"rewrites"`
}

// WikiLinkFileFailure names a file whose links needed rewriting but could not
// be written.
type WikiLinkFileFailure struct {
	Path  string `json:"path"`
	Error string `json:"error"`
}

// WikiLinkPropagationReport is the outcome of one propagation pass: the
// renames it handled and every link it rewrote. It is a complete record of
// that pass, never a delta against an earlier one. Files is empty when no
// link needed rewriting.
type WikiLinkPropagationReport struct {
	// Root is the absolute workspace root the pass was confined to.
	Root    string                 `json:"root"`
	Renames []WikiLinkRename       `json:"renames"`
	Files   []WikiLinkFileRewrites `json:"files"`
	// RewriteCount is the total number of links rewritten across Files.
	RewriteCount int                   `json:"rewriteCount"`
	Failed       []WikiLinkFileFailure `json:"failed,omitempty"`
}

// Reasons a wiki link fails to resolve.
const (
	// WikiLinkMissing: nothing in the workspace matches the target.
	WikiLinkMissing = "missing"
	// WikiLinkAmbiguous: the target is a bare name that more than one file
	// carries, so it names no single file.
	WikiLinkAmbiguous = "ambiguous"
)

// WikiLinkBrokenLink is one wiki link that resolves to no single file.
type WikiLinkBrokenLink struct {
	// Path is the workspace-relative path of the file holding the link.
	Path string `json:"path"`
	// Line is the 1-based line the link sits on.
	Line int `json:"line"`
	// Link is the full link text, brackets included.
	Link string `json:"link"`
	// Target is the link's target with any alias and `#section` removed.
	Target string `json:"target"`
	// Reason is WikiLinkMissing or WikiLinkAmbiguous.
	Reason string `json:"reason"`
	// Candidates lists the files an ambiguous target could name.
	Candidates []string `json:"candidates,omitempty"`
}

// WikiLinkIntegrityReport is the result of one link integrity scan. Broken is
// empty, never nil, when every link resolves.
type WikiLinkIntegrityReport struct {
	// Root is the absolute workspace root that was scanned.
	Root string `json:"root"`
	// DocumentsScanned is the number of document files read.
	DocumentsScanned int `json:"documentsScanned"`
	// LinksChecked is the number of wiki links resolved.
	LinksChecked int                  `json:"linksChecked"`
	Broken       []WikiLinkBrokenLink `json:"broken"`
}

package ion

import "context"

// WorkspaceFileRenamedInfo is the payload for workspace_file_renamed. The
// absolute paths are OS-native; the relative paths are forward-slash
// separated and relative to the session's working directory.
//
// Only files the engine tracks for renames produce the hook: the document
// extensions of the engine's wikiLinks config block, while it is enabled.
type WorkspaceFileRenamedInfo struct {
	OldPath    string `json:"oldPath"`
	OldRelPath string `json:"oldRelPath"`
	NewPath    string `json:"newPath"`
	NewRelPath string `json:"newRelPath"`
}

// WikiLinkRename is one detected document rename. Both paths are relative to
// the workspace root and forward-slash separated.
type WikiLinkRename struct {
	OldPath string `json:"oldPath"`
	NewPath string `json:"newPath"`
}

// WikiLinkRewrite is one rewritten wiki link. OldLink and NewLink are the
// full link text, brackets included; an alias and a #section suffix are
// carried over unchanged. OldTarget and NewTarget are the workspace-relative
// paths the link resolved to before and after the rename.
type WikiLinkRewrite struct {
	Line      int    `json:"line"`
	OldLink   string `json:"oldLink"`
	NewLink   string `json:"newLink"`
	OldTarget string `json:"oldTarget"`
	NewTarget string `json:"newTarget"`
}

// WikiLinkFileRewrites lists the links rewritten in one file. Path is
// workspace-relative.
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

// WikiLinkPropagationReport is the payload for wiki_links_propagated: the
// complete record of one propagation pass. It fires once per pass, even when
// no link needed rewriting (Files is then empty).
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
	// WikiLinkAmbiguous: a bare name that more than one file carries.
	WikiLinkAmbiguous = "ambiguous"
)

// WikiLinkBrokenLink is one wiki link that resolves to no single file.
type WikiLinkBrokenLink struct {
	// Path is the workspace-relative path of the file holding the link.
	Path string `json:"path"`
	Line int    `json:"line"`
	// Link is the full link text, brackets included.
	Link string `json:"link"`
	// Target is the link target with any alias and #section removed.
	Target string `json:"target"`
	// Reason is WikiLinkMissing or WikiLinkAmbiguous.
	Reason string `json:"reason"`
	// Candidates lists the files an ambiguous target could name.
	Candidates []string `json:"candidates,omitempty"`
}

// WikiLinkIntegrityReport is the result of [Context.ScanWikiLinks].
type WikiLinkIntegrityReport struct {
	// Root is the absolute workspace root that was scanned.
	Root             string               `json:"root"`
	DocumentsScanned int                  `json:"documentsScanned"`
	LinksChecked     int                  `json:"linksChecked"`
	Broken           []WikiLinkBrokenLink `json:"broken"`
}

// ScanWikiLinks runs the read-only link integrity scan over the session's
// working directory and returns every wiki link that names no single file.
// Nothing is written. It errors when the engine's wikiLinks config turns the
// scan off.
func (c *Context) ScanWikiLinks(ctx context.Context) (WikiLinkIntegrityReport, error) {
	var out WikiLinkIntegrityReport
	if err := c.sdk.call(ctx, "ext/scan_wiki_links", map[string]any{}, &out); err != nil {
		return WikiLinkIntegrityReport{}, err
	}
	if out.Broken == nil {
		out.Broken = []WikiLinkBrokenLink{}
	}
	return out, nil
}

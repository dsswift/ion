package wikilinks

import (
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// Scan reads every document under the root and reports each wiki link that
// names no single file: one whose target is missing, or a bare name that more
// than one file carries. It writes nothing.
func Scan(opts Options) (types.WikiLinkIntegrityReport, error) {
	report := types.WikiLinkIntegrityReport{Broken: []types.WikiLinkBrokenLink{}}
	root, files, err := listFiles(opts)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "wikilinks", "scan: listing workspace failed", map[string]any{"root": opts.Root, "error": err.Error()})
		return report, err
	}
	report.Root = root
	c := newCorpus(files, opts.Extensions)

	for _, rel := range files {
		if !opts.isDocument(rel) {
			continue
		}
		content, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(rel)))
		if err != nil {
			utils.LogWithFields(utils.LevelWarn, "wikilinks", "scan: document not read", map[string]any{"root": root, "path": rel, "error": err.Error()})
			continue
		}
		report.DocumentsScanned++
		if !hasLinks(content) {
			continue
		}
		for _, l := range parseLinks(content) {
			report.LinksChecked++
			res := c.resolve(l.target, rel)
			if res.resolved() {
				continue
			}
			broken := types.WikiLinkBrokenLink{
				Path:   rel,
				Line:   l.line,
				Link:   string(content[l.start:l.end]),
				Target: l.target,
				Reason: types.WikiLinkMissing,
			}
			if len(res.candidates) > 0 {
				broken.Reason = types.WikiLinkAmbiguous
				broken.Candidates = res.candidates
			}
			report.Broken = append(report.Broken, broken)
		}
	}

	utils.LogWithFields(utils.LevelInfo, "wikilinks", "scan: done", map[string]any{
		"root": root, "documents": report.DocumentsScanned, "links": report.LinksChecked, "broken": len(report.Broken),
	})
	return report, nil
}

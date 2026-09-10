package tools

import (
	"bufio"
	"context"
	"fmt"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"github.com/bmatcuk/doublestar/v4"
	"github.com/dsswift/ion/engine/internal/types"
)

// Native (pure-Go) content search, used when neither ripgrep nor grep is on
// PATH.
//
// Grep previously tried `rg` and fell back to `grep`. On a stock Windows
// machine neither exists, so the tool returned
// `exec: "grep": executable file not found in %PATH%` for every call — a hard
// failure with no degraded mode, which takes out any workflow that searches
// before it edits. Glob already solved the same problem for filename matching
// by falling back to an in-process walker (globWithDoublestar); this is the
// content-search equivalent, so the tool's availability no longer depends on
// what the operator happens to have installed.
//
// It is deliberately last in the chain rather than the default: ripgrep is
// substantially faster on a large tree and honours .gitignore, which this does
// not. The goal is a Grep that always answers, not a reimplementation of rg.

// Caps that keep a pathological pattern or a huge tree from wedging the run.
// A result set past these is truncated with a notice, never silently cut.
const (
	maxGrepMatches  = 500
	maxGrepFileSize = 8 << 20 // 8 MiB; past this a file is treated as data
	maxGrepLineLen  = 2000    // a longer matching line is elided at the cap
)

// grepNative walks searchPath and returns matches formatted the same way the
// ripgrep path formats them, so a caller cannot tell which engine answered.
func grepNative(
	ctx context.Context,
	pattern, searchPath, glob, outputMode, cwd string,
) (*types.ToolResult, error) {
	re, err := regexp.Compile(pattern)
	if err != nil {
		return &types.ToolResult{
			Content: fmt.Sprintf("Error: invalid pattern %q: %v", pattern, err),
			IsError: true,
		}, nil
	}

	root := cwd
	if searchPath != "" {
		root = resolvePath(cwd, searchPath)
	}

	// A file path as the search target is legal and must not be walked.
	info, statErr := os.Stat(root)
	if statErr != nil {
		return &types.ToolResult{
			Content: fmt.Sprintf("Error: cannot search %q: %v", root, statErr),
			IsError: true,
		}, nil
	}

	var (
		contentLines []string
		fileMatches  []string
		counts       = map[string]int{}
		truncated    bool
	)

	consider := func(path string) error {
		if glob != "" {
			// Match the base name, which is what a caller means by "*.ts".
			// doublestar is already a dependency (the Glob fallback uses it),
			// so a pattern like "**/*.go" behaves identically in both tools.
			ok, matchErr := doublestar.Match(glob, filepath.Base(path))
			if matchErr != nil || !ok {
				// A "**/" pattern only matches against the relative path.
				rel, relErr := filepath.Rel(root, path)
				if relErr != nil {
					return nil
				}
				ok2, _ := doublestar.Match(glob, filepath.ToSlash(rel)) //nolint:errcheck // a bad glob simply matches nothing
				if !ok2 {
					return nil
				}
			}
		}

		matches, fileErr := grepFile(ctx, path, re, outputMode)
		if fileErr != nil {
			// An unreadable file is skipped, not fatal: a locked file or a
			// permission-denied directory entry must not fail the whole
			// search. The count still reflects what was searched.
			return nil //nolint:nilerr // intentional skip; see comment
		}
		if len(matches) == 0 {
			return nil
		}

		switch outputMode {
		case "files_with_matches":
			fileMatches = append(fileMatches, path)
		case "count":
			counts[path] = len(matches)
		default:
			for _, m := range matches {
				if len(contentLines) >= maxGrepMatches {
					truncated = true
					return fs.SkipAll
				}
				contentLines = append(contentLines, m)
			}
		}
		if outputMode != "content" && len(fileMatches)+len(counts) >= maxGrepMatches {
			truncated = true
			return fs.SkipAll
		}
		return nil
	}

	if !info.IsDir() {
		if err := consider(root); err != nil && err != fs.SkipAll {
			return &types.ToolResult{Content: "Error: " + err.Error(), IsError: true}, nil
		}
	} else if err := walkForGrep(ctx, root, consider); err != nil {
		// Fall through to the ctx check below so a timeout mid-walk still
		// returns the matches found before it fired.
		if ctx.Err() == nil {
			return &types.ToolResult{Content: "Error: " + err.Error(), IsError: true}, nil
		}
	}

	// A deadline or cancel returns what was already found rather than throwing
	// it away. A partial answer with an honest notice is useful; "Error:
	// exceeded 60s" after a minute of work is not, and it hides the fact that
	// matches existed.
	if ctxErr := ctx.Err(); ctxErr != nil {
		if len(contentLines)+len(fileMatches)+len(counts) == 0 {
			return grepCtxResult(ctxErr), nil
		}
		res := grepNativeResult(outputMode, contentLines, fileMatches, counts, truncated)
		res.Content += grepIncompleteNotice(ctxErr)
		return res, nil
	}

	return grepNativeResult(outputMode, contentLines, fileMatches, counts, truncated), nil
}

// walkForGrep walks dir, skipping the directories a content search never wants
// and checking ctx often enough that a cancel or deadline lands promptly.
func walkForGrep(ctx context.Context, dir string, fn func(string) error) error {
	return filepath.WalkDir(dir, func(path string, d fs.DirEntry, err error) error {
		if err != nil {
			// Skip what cannot be read rather than abandoning the search.
			if d != nil && d.IsDir() {
				return fs.SkipDir
			}
			return nil //nolint:nilerr // intentional skip of an unreadable entry
		}
		if ctxErr := ctx.Err(); ctxErr != nil {
			return ctxErr
		}
		if d.IsDir() {
			// Never skip the root itself. A caller who names a directory
			// explicitly means it, even one on the skip list -- silently
			// returning nothing for `path: node_modules` would be a worse
			// failure than a slow search.
			if path != dir && skipGrepDir(d.Name()) {
				return fs.SkipDir
			}
			return nil
		}
		// A directory symlink or Windows junction is not walked by WalkDir,
		// but a symlinked FILE would still be opened; skip both. A Windows
		// profile is full of legacy junctions (Local Settings -> AppData\Local)
		// whose targets are already walked directly.
		if d.Type()&fs.ModeSymlink != 0 {
			return nil
		}
		if !d.Type().IsRegular() {
			return nil
		}
		if info, statErr := d.Info(); statErr == nil && info.Size() > maxGrepFileSize {
			return nil
		}
		return fn(path)
	})
}

// Directories whose contents are never the answer to a source search and are
// large enough to dominate the walk. ripgrep gets this from .gitignore; this
// list is the honest minimum rather than an attempt to reimplement that.
var grepSkipDirs = map[string]bool{
	".git":         true,
	"node_modules": true,
	"vendor":       true,
	"dist":         true,
	"build":        true,
	"out":          true,
	".next":        true,
	".cache":       true,
	"__pycache__":  true,
	".venv":        true,
	"venv":         true,
	"target":       true,
	"Pods":         true,
	".gradle":      true,
	".idea":        true,
	"graphify-out": true,

	// Windows profile trees. A search rooted at C:\Users\<name> otherwise
	// opens every file in them: measured on one endpoint, AppData held 20,109
	// of the profile's 29,177 files, and "Local Settings"/"Application Data"
	// are legacy junctions onto the same content. Opening each file also pays
	// Defender's real-time scan, which is what turned a plain profile search
	// into a 60s timeout.
	"AppData":                   true,
	"Application Data":          true,
	"Local Settings":            true,
	"Cookies":                   true,
	"NetHood":                   true,
	"PrintHood":                 true,
	"Recent":                    true,
	"SendTo":                    true,
	"Start Menu":                true,
	"Templates":                 true,
	"$RECYCLE.BIN":              true,
	"System Volume Information": true,
}

func skipGrepDir(name string) bool { return grepSkipDirs[name] }

// grepFile scans one file. A file whose first block holds a NUL byte is
// treated as binary and skipped, which is what rg does and what keeps an
// executable out of a source search.
func grepFile(ctx context.Context, path string, re *regexp.Regexp, outputMode string) ([]string, error) {
	f, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer f.Close() //nolint:errcheck // read-only handle; close failure is not actionable

	buf := make([]byte, 512)
	n, _ := f.Read(buf) //nolint:errcheck // a read failure is handled as "not binary" and caught by the scanner below
	if bytesContainNUL(buf[:n]) {
		return nil, nil
	}
	if _, err := f.Seek(0, 0); err != nil {
		return nil, err
	}

	var out []string
	scanner := bufio.NewScanner(f)
	scanner.Buffer(make([]byte, 64<<10), 1<<20)
	lineNo := 0
	for scanner.Scan() {
		lineNo++
		// Checking every line would dominate the scan; every 512 is frequent
		// enough that a cancel is not perceptibly delayed.
		if lineNo%512 == 0 {
			if ctxErr := ctx.Err(); ctxErr != nil {
				return nil, ctxErr
			}
		}
		line := scanner.Text()
		if !re.MatchString(line) {
			continue
		}
		if outputMode == "files_with_matches" {
			// One match settles it; no reason to read the rest.
			return []string{path}, nil
		}
		if len(line) > maxGrepLineLen {
			line = line[:maxGrepLineLen] + "…"
		}
		out = append(out, fmt.Sprintf("%s:%d:%s", path, lineNo, line))
	}
	if err := scanner.Err(); err != nil {
		return nil, err
	}
	return out, nil
}

func bytesContainNUL(b []byte) bool {
	for _, c := range b {
		if c == 0 {
			return true
		}
	}
	return false
}

// grepIncompleteNotice explains that the result set is partial and says what
// to do about it, so a caller does not read a truncated answer as a complete
// one.
func grepIncompleteNotice(err error) string {
	if err == context.DeadlineExceeded {
		return fmt.Sprintf("\n(incomplete: the search hit the %s deadline. These are the matches found so far -- narrow the path or add a glob for a complete answer.)", globTimeout)
	}
	return "\n(incomplete: the search was cancelled. These are the matches found so far.)"
}

func grepCtxResult(err error) *types.ToolResult {
	if err == context.DeadlineExceeded {
		return &types.ToolResult{
			Content: fmt.Sprintf("Error: Grep exceeded %s deadline.", globTimeout),
			IsError: true,
		}
	}
	return &types.ToolResult{Content: "Error: Grep cancelled.", IsError: true}
}

// grepNativeResult formats the collected matches to match the ripgrep path's
// output, including its "(no matches)" wording, so switching engines never
// changes what a caller parses.
func grepNativeResult(
	outputMode string,
	contentLines, fileMatches []string,
	counts map[string]int,
	truncated bool,
) *types.ToolResult {
	var lines []string
	switch outputMode {
	case "files_with_matches":
		lines = fileMatches
		sort.Strings(lines)
	case "count":
		for path, n := range counts {
			lines = append(lines, fmt.Sprintf("%s:%d", path, n))
		}
		sort.Strings(lines)
	default:
		lines = contentLines
	}

	if len(lines) == 0 {
		return &types.ToolResult{Content: "(no matches)"}
	}
	out := strings.Join(lines, "\n")
	if truncated {
		out += fmt.Sprintf("\n(truncated at %d matches; narrow the pattern or path)", maxGrepMatches)
	}
	return &types.ToolResult{Content: out}
}

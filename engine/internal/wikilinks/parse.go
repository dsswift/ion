// Package wikilinks maintains wiki-style `[[target]]` links inside one
// workspace root: it rewrites links when the file they name is renamed, and
// it reports links that resolve to nothing.
//
// The package owns mechanism only. It is handed a root, an ignore predicate,
// and the document extensions; what triggers a pass and who receives the
// report is the caller's business. Every operation is confined to regular
// files under the root that the ignore predicate admits; symbolic links are
// never followed and never rewritten.
package wikilinks

import (
	"bytes"
	"regexp"
	"strings"
)

// link is one `[[...]]` occurrence in a document.
type link struct {
	// start and end bound the whole link in the document, brackets included.
	start, end int
	// line is the 1-based line the link starts on.
	line int
	// lead and trail are the whitespace around the target, kept so a rewrite
	// changes nothing but the target.
	lead, trail string
	// target is the trimmed link target: everything before a `#` or `|`.
	target string
	// suffix is everything after the target, verbatim: the `#section` part
	// and the `|alias` part.
	suffix string
}

// text renders the link with a replacement target.
func (l link) text(target string) string {
	return "[[" + l.lead + target + l.trail + l.suffix + "]]"
}

var (
	fenceOpenRe  = regexp.MustCompile("^\\s*(`{3,}|~{3,})")
	inlineCodeRe = regexp.MustCompile("`[^`\n]*`")
	linkRe       = regexp.MustCompile(`\[\[([^\]\n]+?)\]\]`)
	// posixClassRe matches the inside of a regex character class such as
	// `[[:space:]]`, which has the shape of a wiki link and never is one.
	posixClassRe = regexp.MustCompile(`^:[a-z]+:$`)
)

// hasLinks is the cheap pre-check that lets a document with no wiki links
// skip parsing entirely.
func hasLinks(content []byte) bool {
	return bytes.Contains(content, []byte("[["))
}

// parseLinks returns every wiki link in content, in document order. Text
// inside a fenced code block or an inline code span is not a link.
func parseLinks(content []byte) []link {
	var out []link
	offset := 0
	lineNo := 0
	fenceChar := byte(0)
	fenceLen := 0

	for offset <= len(content) {
		end := bytes.IndexByte(content[offset:], '\n')
		var line []byte
		next := len(content) + 1
		if end < 0 {
			line = content[offset:]
		} else {
			line = content[offset : offset+end]
			next = offset + end + 1
		}
		lineNo++

		switch {
		case fenceChar == 0:
			if m := fenceOpenRe.FindSubmatch(line); m != nil {
				fenceChar = m[1][0]
				fenceLen = len(m[1])
			} else {
				out = appendLineLinks(out, line, offset, lineNo)
			}
		case closesFence(line, fenceChar, fenceLen):
			fenceChar = 0
		}
		offset = next
	}
	return out
}

// closesFence reports whether line closes a fence opened with fenceLen
// repetitions of fenceChar: the same character, at least as many, and nothing
// else on the line.
func closesFence(line []byte, fenceChar byte, fenceLen int) bool {
	trimmed := bytes.TrimSpace(line)
	if len(trimmed) < fenceLen {
		return false
	}
	for _, b := range trimmed {
		if b != fenceChar {
			return false
		}
	}
	return true
}

// appendLineLinks parses the links on one line that sits outside any fence.
func appendLineLinks(out []link, line []byte, lineOffset, lineNo int) []link {
	if !bytes.Contains(line, []byte("[[")) {
		return out
	}
	masked := line
	if bytes.IndexByte(line, '`') >= 0 {
		masked = inlineCodeRe.ReplaceAllFunc(line, func(span []byte) []byte {
			return bytes.Repeat([]byte(" "), len(span))
		})
	}
	for _, m := range linkRe.FindAllSubmatchIndex(masked, -1) {
		l, ok := parseInner(string(line[m[2]:m[3]]))
		if !ok {
			continue
		}
		l.start = lineOffset + m[0]
		l.end = lineOffset + m[1]
		l.line = lineNo
		out = append(out, l)
	}
	return out
}

// parseInner splits the text between the brackets into target and suffix.
// It reports false for a link with no target, such as `[[#section]]`, which
// points into its own document, and for a regex character class such as
// `[[:space:]]`.
func parseInner(inner string) (link, bool) {
	if posixClassRe.MatchString(inner) {
		return link{}, false
	}
	targetPart := inner
	suffix := ""
	if pipe := strings.IndexByte(inner, '|'); pipe >= 0 {
		cut := pipe
		// Inside a table cell the alias separator is written `\|`.
		if pipe > 0 && inner[pipe-1] == '\\' {
			cut = pipe - 1
		}
		targetPart, suffix = inner[:cut], inner[cut:]
	}
	if hash := strings.IndexByte(targetPart, '#'); hash >= 0 {
		targetPart, suffix = targetPart[:hash], targetPart[hash:]+suffix
	}
	target := strings.TrimSpace(targetPart)
	if target == "" {
		return link{}, false
	}
	leadLen := strings.Index(targetPart, target)
	return link{
		lead:   targetPart[:leadLen],
		trail:  targetPart[leadLen+len(target):],
		target: target,
		suffix: suffix,
	}, true
}

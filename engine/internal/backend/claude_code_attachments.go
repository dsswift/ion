package backend

import (
	"encoding/base64"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/dsswift/ion/engine/internal/types"
)

// maxInlineAttachmentBytes caps a file we will base64-inline as a content
// block. Anthropic's PDF limit is ~32MB; staying well under it leaves headroom
// for the ~33% base64 inflation. Files larger than this keep their marker so
// the model falls back to the Read tool.
const maxInlineAttachmentBytes = 24 * 1024 * 1024

// attachmentMarkerRe matches the `[Attached file|image|plan: <path>]` markers
// the harness before_prompt resolver leaves in the prompt after materializing
// the referenced file to an absolute path. Mirrors attachmentResolver.ts
// MARKER_RE.
// Note: `plan` markers are captured by this regex but are intentionally NOT
// consumed by the document-block builder — the `kind != "file"` guard in the
// loop body passes them through untouched so the model still sees the marker
// text and can act on the plan context via the Read tool.
var attachmentMarkerRe = regexp.MustCompile(`\[Attached (file|image|plan): ([^\]]+)\]`)

// buildCliUserContent turns the resolved prompt plus pre-encoded image
// attachments into the content-block slice for the CLI stream-json user
// message.
//
// PDFs referenced by `[Attached file: <abs>]` markers are read from disk and
// inlined as native `document` blocks so the model ingests them directly,
// instead of the Read tool expanding each page into a separate image block and
// stalling the request for minutes (#789). opts.Attachments (already base64)
// becomes `image` blocks for image/* media types and `document` blocks for
// application/pdf -- the latter is how remote clients deliver documents whose
// paths only exist on the client machine (#853).
//
// Anything we cannot or should not inline (non-PDF files, `plan` markers,
// oversized or unreadable files) keeps its marker untouched so the existing
// Read-tool path still works. The non-attachment case returns a single text
// block identical to the previous hardcoded behavior.
func buildCliUserContent(prompt string, attachments []types.ImageAttachment) []map[string]interface{} {
	text := prompt
	media := make([]map[string]interface{}, 0, len(attachments)+1)

	// Document blocks: read PDFs referenced by `file` markers from disk.
	seen := make(map[string]bool)
	for _, m := range attachmentMarkerRe.FindAllStringSubmatch(prompt, -1) {
		full, kind, path := m[0], m[1], m[2]
		if kind != "file" || strings.ToLower(filepath.Ext(path)) != ".pdf" {
			continue // only PDFs get the document-block treatment in v1
		}
		if seen[path] {
			text = strings.ReplaceAll(text, full, "")
			continue // already inlined this file; just drop the duplicate marker
		}
		info, err := os.Stat(path)
		if err != nil || info.Size() == 0 || info.Size() > maxInlineAttachmentBytes {
			continue // leave marker; model falls back to the Read tool
		}
		data, err := os.ReadFile(path)
		if err != nil {
			continue
		}
		seen[path] = true
		media = append(media, map[string]interface{}{
			"type": "document",
			"source": map[string]interface{}{
				"type":       "base64",
				"media_type": "application/pdf",
				"data":       base64.StdEncoding.EncodeToString(data),
			},
		})
		text = strings.ReplaceAll(text, full, "") // consumed -> strip marker
	}

	// Wire-attachment blocks: opts.Attachments carries pre-encoded base64
	// content from the client. Images become `image` blocks. PDFs become
	// `document` blocks -- this is the remote-desktop path (#853): the
	// client's filesystem is not reachable from the engine host, so the
	// bytes ride the wire instead of a path marker. Unknown media types are
	// skipped (their marker, if any, stays for the Read fallback).
	consumedPaths := make(map[string]bool)
	for _, a := range attachments {
		if a.Data == "" || a.MediaType == "" {
			continue
		}
		switch {
		case a.MediaType == "application/pdf":
			media = append(media, map[string]interface{}{
				"type": "document",
				"source": map[string]interface{}{
					"type":       "base64",
					"media_type": "application/pdf",
					"data":       a.Data,
				},
			})
		case strings.HasPrefix(a.MediaType, "image/"):
			media = append(media, map[string]interface{}{
				"type": "image",
				"source": map[string]interface{}{
					"type":       "base64",
					"media_type": a.MediaType,
					"data":       a.Data,
				},
			})
		default:
			continue
		}
		if a.Path != "" {
			consumedPaths[a.Path] = true
		}
	}
	if len(attachments) > 0 {
		// Strip markers the wire attachments made redundant: every `image`
		// marker (the desktop adds one 1:1 alongside each encoded image) and
		// any `file` marker whose path matches a consumed wire attachment --
		// otherwise the model would try to Read a path that may not exist on
		// this host.
		text = attachmentMarkerRe.ReplaceAllStringFunc(text, func(s string) string {
			sub := attachmentMarkerRe.FindStringSubmatch(s)
			if sub == nil {
				return s
			}
			if sub[1] == "image" || (sub[1] == "file" && consumedPaths[sub[2]]) {
				return ""
			}
			return s
		})
	}

	// Text block first (matches ApiBackend's buildUserContentBlocks). Collapse
	// whitespace left by stripped markers; keep a non-empty placeholder so the
	// message stays well-formed when the prompt was only an attachment.
	text = strings.TrimSpace(text)
	if text == "" && len(media) > 0 {
		text = "(see attached)"
	}
	blocks := make([]map[string]interface{}, 0, len(media)+1)
	blocks = append(blocks, map[string]interface{}{"type": "text", "text": text})
	blocks = append(blocks, media...)
	return blocks
}

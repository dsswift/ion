package conversation

import (
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"github.com/dsswift/ion/engine/internal/utils"
)

// imageExtByMediaType maps a MIME media type to the file extension used when
// saving an image to the conversation images directory. Unknown types fall back
// to ".bin" so a save never fails on an unrecognized type — the bytes are still
// preserved and the path is still emitted.
var imageExtByMediaType = map[string]string{
	"image/png":  "png",
	"image/jpeg": "jpg",
	"image/jpg":  "jpg",
	"image/webp": "webp",
	"image/gif":  "gif",
	"image/heic": "heic",
	"image/heif": "heif",
}

// SaveImageToConversation decodes base64 image data and writes it to
// ~/.ion/conversations/{convID}/images/{sha256(bytes)}.{ext}, returning the
// absolute file path. The extension is derived from mediaType (falling back to
// ".bin" for unknown types).
//
// The filename is CONTENT-ADDRESSED: it is the SHA-256 of the decoded bytes.
// This makes the save idempotent — the same image bytes always resolve to the
// same path, and a save that finds the file already present skips the write.
// That property is load-bearing for historical reload: the live emit-time save
// (backend runloop) and the reload-time save (flattenEntries, re-deriving the
// path from a persisted base64 image block) converge on the exact same file, so
// a reloaded conversation references the same on-disk image the live session
// wrote — never a duplicate, and never a dangling path when the file survived.
//
// This is the single shared saver for both tool-returned images (backend
// runloop) and provider-generated images (normalizer). It puts image bytes on
// disk so events can carry a FILE PATH rather than base64 on the wire.
//
// When dir is empty, the default ~/.ion/conversations root is used (matching
// Save/Load). convID must be non-empty; an empty convID is a programming error
// and returns an error rather than writing to a stray directory.
func SaveImageToConversation(dir, convID, mediaType, base64Data string) (string, error) {
	if convID == "" {
		return "", fmt.Errorf("SaveImageToConversation: convID is required")
	}
	if dir == "" {
		dir = DefaultConversationsDir()
	}

	data, err := base64.StdEncoding.DecodeString(base64Data)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "conversation", "image base64 decode failed", map[string]any{
			"conversation_id": convID,
			"mediaType":       mediaType,
			"error":           utils.ErrStr(err),
		})
		return "", fmt.Errorf("SaveImageToConversation: base64 decode: %w", err)
	}

	ext, ok := imageExtByMediaType[mediaType]
	if !ok {
		ext = "bin"
		utils.LogWithFields(utils.LevelInfo, "conversation", "unknown image media type; using .bin extension", map[string]any{
			"conversation_id": convID,
			"mediaType":       mediaType,
		})
	}

	imagesDir := filepath.Join(dir, convID, "images")
	if err := os.MkdirAll(imagesDir, 0o755); err != nil {
		return "", fmt.Errorf("SaveImageToConversation: mkdir %s: %w", imagesDir, err)
	}

	sum := sha256.Sum256(data)
	name := hex.EncodeToString(sum[:]) + "." + ext
	path := filepath.Join(imagesDir, name)

	// Content-addressed: if the file is already present (same bytes, same name),
	// the save is a no-op. This is what makes the live save and the reload save
	// idempotent against each other — no duplicate write, no second file.
	if _, statErr := os.Stat(path); statErr == nil {
		utils.LogWithFields(utils.LevelDebug, "conversation", "image already present (content-addressed); skipping write", map[string]any{
			"conversation_id": convID,
			"mediaType":       mediaType,
			"path":            path,
		})
		return path, nil
	}

	if err := os.WriteFile(path, data, 0o644); err != nil {
		return "", fmt.Errorf("SaveImageToConversation: write %s: %w", path, err)
	}

	utils.LogWithFields(utils.LevelInfo, "conversation", "image saved to conversation", map[string]any{
		"conversation_id": convID,
		"mediaType":       mediaType,
		"path":            path,
		"bytes":           len(data),
	})
	return path, nil
}

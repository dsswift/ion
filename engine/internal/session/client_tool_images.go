package session

import "github.com/dsswift/ion/engine/internal/types"

// clientToolResultImages translates the client wire attachment shape into the
// provider-facing ToolResult image shape. It intentionally accepts the same
// base64 contract as send_prompt, so a remote client never needs filesystem
// access to the engine host to return a screenshot or other vision result.
func clientToolResultImages(attachments []types.ImageAttachment) []*types.ImageSource {
	images := make([]*types.ImageSource, 0, len(attachments))
	for _, attachment := range attachments {
		if attachment.Data == "" || attachment.MediaType == "" {
			continue
		}
		images = append(images, &types.ImageSource{
			Type:        "base64",
			MediaType:   attachment.MediaType,
			Data:        attachment.Data,
			ContentHash: attachment.ContentHash,
		})
	}
	return images
}

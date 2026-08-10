package types

import "encoding/json"

// ToolContent is one ordered content item returned by a tool. It mirrors MCP
// content blocks so extensions can inspect binary resources without forcing the
// engine to materialize or persist their payloads.
type ToolContent struct {
	Type        string            `json:"type"`
	Text        string            `json:"text,omitempty"`
	Data        string            `json:"data,omitempty"`
	MimeType    string            `json:"mimeType,omitempty"`
	Resource    *EmbeddedResource `json:"resource,omitempty"`
	URI         string            `json:"uri,omitempty"`
	Name        string            `json:"name,omitempty"`
	Title       string            `json:"title,omitempty"`
	Description string            `json:"description,omitempty"`
	Size        int64             `json:"size,omitempty"`
	Annotations *ToolAnnotations  `json:"annotations,omitempty"`
	Unknown     json.RawMessage   `json:"unknown,omitempty"`
}

// EmbeddedResource is text or base64 data embedded in a tool-result resource
// item. Blob remains base64 until an explicit consumer chooses to decode it.
type EmbeddedResource struct {
	URI      string `json:"uri,omitempty"`
	MimeType string `json:"mimeType,omitempty"`
	Text     string `json:"text,omitempty"`
	Blob     string `json:"blob,omitempty"`
}

// ToolAnnotations preserves standard MCP delivery hints without making them
// engine policy. Consumers decide whether and how to use them.
type ToolAnnotations struct {
	Audience     []string `json:"audience,omitempty"`
	Priority     *float64 `json:"priority,omitempty"`
	LastModified string   `json:"lastModified,omitempty"`
}

// MaxEphemeralVisionDataChars caps the base64 payload that can be forwarded to
// a provider in one tool result. It bounds memory while leaving opaque content
// available to SDK consumers through ContentItems.
const MaxEphemeralVisionDataChars = 20 * 1024 * 1024 * 4 / 3

// ToolContentEphemeralImages returns supported vision blocks carried by tool
// content. These images are model input only: callers must keep them out of
// events and persistence unless they deliberately choose a durable path.
func ToolContentEphemeralImages(items []ToolContent) []*ImageSource {
	var images []*ImageSource
	for _, item := range items {
		mimeType, data := item.MimeType, item.Data
		if item.Type == "resource" && item.Resource != nil {
			mimeType, data = item.Resource.MimeType, item.Resource.Blob
		}
		if !isVisionMediaType(mimeType) || data == "" || len(data) > MaxEphemeralVisionDataChars {
			continue
		}
		images = append(images, &ImageSource{
			Type:      "base64",
			MediaType: mimeType,
			Data:      data,
		})
	}
	return images
}

func isVisionMediaType(mimeType string) bool {
	switch mimeType {
	case "image/png", "image/jpeg", "image/gif", "image/webp":
		return true
	default:
		return false
	}
}

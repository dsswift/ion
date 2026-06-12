package extension

import "github.com/dsswift/ion/engine/internal/types"

// DeclareResourceParams is the JSON-RPC params for ext/declare_resource.
type DeclareResourceParams struct {
	Kind string `json:"kind"`
}

// PublishResourceParams is the JSON-RPC params for ext/publish_resource.
type PublishResourceParams struct {
	Kind string             `json:"kind"`
	Op   string             `json:"op"`
	Item types.ResourceItem `json:"item"`
}

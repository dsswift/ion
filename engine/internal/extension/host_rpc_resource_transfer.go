// Resource transfer RPCs: the engine asks an extension producer to export,
// import, or forget the items it holds for a set of conversations, so a
// conversation's resources can move with it to another machine. The engine
// only carries the items; the producer decides how it persists them.
//
//   resource/export {kind, conversationIds} -> []ResourceItem
//   resource/import {kind, items}           -> {accepted, refused}
//   resource/forget {kind, conversationIds} -> {removed}
//
// An SDK answers -32601 when the extension registered no handler for the
// operation; that maps to resource.ErrTransferUnsupported.

package extension

import (
	"encoding/json"
	"errors"
	"fmt"

	"github.com/dsswift/ion/engine/internal/resource"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// rpcMethodNotFound is the JSON-RPC code an SDK returns for an operation the
// extension did not register a handler for.
const rpcMethodNotFound = -32601

// unsupportedOr maps an SDK's "no handler" answer to ErrTransferUnsupported.
func unsupportedOr(err error) error {
	var he *hookError
	if errors.As(err, &he) && he.Code == rpcMethodNotFound {
		return resource.ErrTransferUnsupported
	}
	return err
}

// ResourceTransferHandlers returns the transfer handlers that call into this
// host's subprocess for kind.
func (h *Host) ResourceTransferHandlers(kind string) resource.TransferHandlers {
	return resource.TransferHandlers{
		Export: func(conversationIDs []string) ([]types.ResourceItem, error) {
			return h.CallResourceExport(kind, conversationIDs)
		},
		Import: func(items []types.ResourceItem) (resource.ImportResult, error) {
			return h.CallResourceImport(kind, items)
		},
		Forget: func(conversationIDs []string) (int, error) {
			return h.CallResourceForget(kind, conversationIDs)
		},
	}
}

// CallResourceExport asks the extension for every item of kind it holds for
// the given conversations.
func (h *Host) CallResourceExport(kind string, conversationIDs []string) ([]types.ResourceItem, error) {
	params := struct {
		Kind            string   `json:"kind"`
		ConversationIDs []string `json:"conversationIds"`
	}{Kind: kind, ConversationIDs: conversationIDs}
	raw, err := h.call("resource/export", params)
	if err != nil {
		err = unsupportedOr(err)
		utils.LogWithFields(utils.LevelDebug, "extension", "resource/export: no items", map[string]any{"model": h.name_(), "kind": kind, "error": err.Error()})
		return nil, err
	}
	var items []types.ResourceItem
	if err := json.Unmarshal(raw, &items); err != nil {
		return nil, fmt.Errorf("resource/export kind=%s: decode response: %w", kind, err)
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "resource/export: answered", map[string]any{"model": h.name_(), "kind": kind, "count": len(items)})
	return items, nil
}

// CallResourceImport hands items to the extension to persist.
func (h *Host) CallResourceImport(kind string, items []types.ResourceItem) (resource.ImportResult, error) {
	params := struct {
		Kind  string               `json:"kind"`
		Items []types.ResourceItem `json:"items"`
	}{Kind: kind, Items: items}
	raw, err := h.call("resource/import", params)
	if err != nil {
		return resource.ImportResult{}, unsupportedOr(err)
	}
	var result resource.ImportResult
	if err := json.Unmarshal(raw, &result); err != nil {
		return resource.ImportResult{}, fmt.Errorf("resource/import kind=%s: decode response: %w", kind, err)
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "resource/import: answered", map[string]any{"model": h.name_(), "kind": kind, "count": len(items), "accepted": len(result.Accepted)})
	return result, nil
}

// CallResourceForget tells the extension to drop its items of kind for the
// given conversations.
func (h *Host) CallResourceForget(kind string, conversationIDs []string) (int, error) {
	params := struct {
		Kind            string   `json:"kind"`
		ConversationIDs []string `json:"conversationIds"`
	}{Kind: kind, ConversationIDs: conversationIDs}
	raw, err := h.call("resource/forget", params)
	if err != nil {
		return 0, unsupportedOr(err)
	}
	var result struct {
		Removed int `json:"removed"`
	}
	if err := json.Unmarshal(raw, &result); err != nil {
		return 0, fmt.Errorf("resource/forget kind=%s: decode response: %w", kind, err)
	}
	utils.LogWithFields(utils.LevelInfo, "extension", "resource/forget: answered", map[string]any{"model": h.name_(), "kind": kind, "removed": result.Removed})
	return result.Removed, nil
}

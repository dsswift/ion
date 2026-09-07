package stream

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"

	"github.com/Azure/azure-sdk-for-go/sdk/azcore"
	"github.com/Azure/azure-sdk-for-go/sdk/azcore/to"
	"github.com/Azure/azure-sdk-for-go/sdk/data/azcosmos"
)

// cosmos.go is the hot store's shape: one document per delivered message,
// partitioned by conversation, ordered by SortKey. The ingest function
// writes it; the transcript and fold commands read and clear it. Nothing
// here is reassembled — the hot store is a log, and the log is what makes
// a redelivery an idempotent upsert rather than a duplicate.

// HotDocument is one delivered message as the ingest function stores it.
// The identity fields are lifted out of the envelope so the container can
// be partitioned and ordered without indexing the whole event; the event
// itself rides whole under Event so nothing the engine emitted is lost.
type HotDocument struct {
	// ID is Envelope.DocumentID: event_id, or event_id:part for a segment.
	ID             string   `json:"id"`
	ConversationID string   `json:"conversation_id"`
	Name           string   `json:"name"`
	Ts             string   `json:"ts"`
	SortKey        string   `json:"sort_key"`
	Seq            int64    `json:"seq"`
	Part           int      `json:"part,omitempty"`
	Parts          int      `json:"parts,omitempty"`
	User           string   `json:"user,omitempty"`
	Event          Envelope `json:"event"`
	IngestedAt     string   `json:"ingested_at"`
	// TTL is Cosmos DB's per-item time-to-live in seconds. The fold job
	// clears a conversation explicitly once it is archived; the TTL is the
	// backstop that keeps the hot store bounded if the fold never runs.
	TTL int `json:"ttl,omitempty"`
}

// CosmosConfig locates the hot store.
type CosmosConfig struct {
	Endpoint  string
	Key       string
	Database  string
	Container string
}

// CosmosConfigFromEnv reads COSMOS_ENDPOINT, COSMOS_KEY, COSMOS_DATABASE,
// COSMOS_CONTAINER with the sample's defaults.
func CosmosConfigFromEnv() CosmosConfig {
	return CosmosConfig{
		Endpoint:  EnvOr("COSMOS_ENDPOINT", "http://localhost:8081/"),
		Key:       os.Getenv("COSMOS_KEY"),
		Database:  EnvOr("COSMOS_DATABASE", "conversations"),
		Container: EnvOr("COSMOS_CONTAINER", "events"),
	}
}

// HotStore is a client for the hot container.
type HotStore struct {
	container *azcosmos.ContainerClient
	cfg       CosmosConfig
}

// OpenHotStore connects and ensures the database and container exist.
// Creating them here as well as in the ingest function means whichever
// process starts first shapes the store, and both shape it the same way.
func OpenHotStore(ctx context.Context, cfg CosmosConfig) (*HotStore, error) {
	if cfg.Key == "" {
		return nil, fmt.Errorf("COSMOS_KEY is required")
	}
	cred, err := azcosmos.NewKeyCredential(cfg.Key)
	if err != nil {
		return nil, fmt.Errorf("cosmos credential: %w", err)
	}
	client, err := azcosmos.NewClientWithKey(cfg.Endpoint, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("cosmos client: %w", err)
	}
	if _, err := client.CreateDatabase(ctx, azcosmos.DatabaseProperties{ID: cfg.Database}, nil); err != nil && !isConflict(err) {
		return nil, fmt.Errorf("cosmos create database %q: %w", cfg.Database, err)
	}
	db, err := client.NewDatabase(cfg.Database)
	if err != nil {
		return nil, err
	}
	props := azcosmos.ContainerProperties{
		ID:                     cfg.Container,
		PartitionKeyDefinition: azcosmos.PartitionKeyDefinition{Paths: []string{"/conversation_id"}},
		// -1 enables per-item TTL without expiring items that set none.
		DefaultTimeToLive: to.Ptr(int32(-1)),
	}
	if _, err := db.CreateContainer(ctx, props, nil); err != nil && !isConflict(err) {
		return nil, fmt.Errorf("cosmos create container %q: %w", cfg.Container, err)
	}
	container, err := db.NewContainer(cfg.Container)
	if err != nil {
		return nil, err
	}
	Logf("INFO", "hot store open", map[string]any{"endpoint": cfg.Endpoint, "database": cfg.Database, "container": cfg.Container})
	return &HotStore{container: container, cfg: cfg}, nil
}

func isConflict(err error) bool {
	var re *azcore.ResponseError
	return errors.As(err, &re) && re.StatusCode == 409
}

// ConversationDocuments reads every document of one conversation in
// SortKey order — a single-partition query, which is what partitioning on
// conversation_id buys: one conversation's whole log lives on one physical
// partition and is read in one pass.
func (h *HotStore) ConversationDocuments(ctx context.Context, conversationID string) ([]HotDocument, error) {
	pk := azcosmos.NewPartitionKeyString(conversationID)
	pager := h.container.NewQueryItemsPager(
		"SELECT * FROM c WHERE c.conversation_id = @id ORDER BY c.sort_key ASC",
		pk,
		&azcosmos.QueryOptions{QueryParameters: []azcosmos.QueryParameter{{Name: "@id", Value: conversationID}}},
	)
	var out []HotDocument
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("cosmos query conversation %s: %w", conversationID, err)
		}
		for _, raw := range page.Items {
			var d HotDocument
			if err := json.Unmarshal(raw, &d); err != nil {
				return nil, fmt.Errorf("cosmos document decode: %w", err)
			}
			out = append(out, d)
		}
	}
	return out, nil
}

// ConversationSummary is what the hot store knows about one conversation
// without reading its content.
type ConversationSummary struct {
	ConversationID string
	Documents      int
	FirstSortKey   string
	LastSortKey    string
	User           string
}

// Conversations lists every conversation in the hot store with its
// document count and activity bounds. It projects only the ordering
// fields across all partitions and aggregates in the client, which keeps
// the query portable across Cosmos DB and its emulator.
func (h *HotStore) Conversations(ctx context.Context) ([]ConversationSummary, error) {
	pager := h.container.NewQueryItemsPager(
		"SELECT c.conversation_id, c.sort_key, c.user FROM c",
		azcosmos.NewPartitionKey(),
		nil,
	)
	byID := map[string]*ConversationSummary{}
	var order []string
	for pager.More() {
		page, err := pager.NextPage(ctx)
		if err != nil {
			return nil, fmt.Errorf("cosmos list conversations: %w", err)
		}
		for _, raw := range page.Items {
			var row struct {
				ConversationID string `json:"conversation_id"`
				SortKey        string `json:"sort_key"`
				User           string `json:"user"`
			}
			if err := json.Unmarshal(raw, &row); err != nil {
				return nil, fmt.Errorf("cosmos row decode: %w", err)
			}
			s := byID[row.ConversationID]
			if s == nil {
				s = &ConversationSummary{ConversationID: row.ConversationID, FirstSortKey: row.SortKey, LastSortKey: row.SortKey, User: row.User}
				byID[row.ConversationID] = s
				order = append(order, row.ConversationID)
			}
			s.Documents++
			if row.SortKey < s.FirstSortKey {
				s.FirstSortKey = row.SortKey
			}
			if row.SortKey > s.LastSortKey {
				s.LastSortKey = row.SortKey
			}
		}
	}
	out := make([]ConversationSummary, 0, len(order))
	for _, id := range order {
		out = append(out, *byID[id])
	}
	return out, nil
}

// DeleteConversation removes every document of one conversation. Returns
// the number deleted. The fold job calls this only after the archive
// object is written and verified against the record of truth.
func (h *HotStore) DeleteConversation(ctx context.Context, conversationID string) (int, error) {
	docs, err := h.ConversationDocuments(ctx, conversationID)
	if err != nil {
		return 0, err
	}
	pk := azcosmos.NewPartitionKeyString(conversationID)
	deleted := 0
	for _, d := range docs {
		if _, err := h.container.DeleteItem(ctx, pk, d.ID, nil); err != nil {
			var re *azcore.ResponseError
			if errors.As(err, &re) && re.StatusCode == 404 {
				continue
			}
			return deleted, fmt.Errorf("cosmos delete %s: %w", d.ID, err)
		}
		deleted++
	}
	return deleted, nil
}

// Envelopes lifts the stored events back out of hot documents.
func Envelopes(docs []HotDocument) []Envelope {
	out := make([]Envelope, 0, len(docs))
	for _, d := range docs {
		out = append(out, d.Event)
	}
	return out
}

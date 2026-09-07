package telemetry

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"sync/atomic"
	"time"

	"github.com/Azure/azure-sdk-for-go/sdk/messaging/azeventhubs/v2"
	"github.com/dsswift/ion/engine/internal/types"
	"github.com/dsswift/ion/engine/internal/utils"
)

// telemetry_eventhub.go implements the "eventhub" target (issue #378):
// Azure Event Hubs as a telemetry / conversation-events sink, alongside
// "http" / "file" / "otel". Authentication is by the engine's own identity
// (eventHubNamespace) or a connection string; see
// telemetry_eventhub_credential.go for the precedence and why a fleet should
// prefer the former.
//
// The real Azure SDK client is hidden behind the eventHubSender interface so
// Collector.deliverToEventHub, the retry queue, and target dispatch are all
// unit-testable with a fake sender. Building a real EventDataBatch always
// requires a live AMQP link (azeventhubs.ProducerClient.NewEventDataBatch
// negotiates a sender link with the service to learn the max batch size),
// so the SDK-backed implementation itself is exercised against the real
// Event Hubs emulator, not an in-process fake — see docs/observability/telemetry.md.
//
// Size contract: the sender reports the link's negotiated maximum message
// size, and every event is fitted to it (telemetry_oversize.go) before it is
// sent or queued. See that file for why.

const (
	// eventHubSendBaseTimeout bounds a send of a small batch. Larger batches
	// — a segmented 50 MB tool output is fifty near-limit messages — get
	// proportionally longer, see eventHubSendTimeoutFor.
	eventHubSendBaseTimeout = 30 * time.Second
	eventHubSendBytesPerSec = 256 * 1024

	// defaultEventHubMaxMessageBytes is the fallback when the link's maximum
	// cannot be negotiated and the operator has not configured one. It is
	// the published Event Hubs per-event limit; the negotiated value is
	// always preferred because the emulator and future tiers may differ.
	defaultEventHubMaxMessageBytes = 1024 * 1024

	// probeMaxMessageCeiling caps the negotiation search. No Event Hubs tier
	// accepts a message anywhere near this; it only bounds the doubling loop.
	probeMaxMessageCeiling = 1 << 31
)

// eventHubSendTimeoutFor scales the send deadline with the batch's payload
// so a legitimately large segmented batch is not abandoned mid-send by a
// deadline sized for metadata.
func eventHubSendTimeoutFor(events []Event) time.Duration {
	total := 0
	for _, e := range events {
		if n, err := encodedSize(e); err == nil {
			total += n
		}
	}
	return eventHubSendBaseTimeout + time.Duration(total/eventHubSendBytesPerSec)*time.Second
}

// eventTooLargeError reports that events[Index] did not fit an empty batch,
// so the link will never accept it as a single message. Every event before
// Index in the same Send call has already been delivered; the caller resumes
// from Index+1 after disposing of the offender.
type eventTooLargeError struct {
	Index int
	Bytes int
	Name  string
	Cause error
}

func (e *eventTooLargeError) Error() string {
	return fmt.Sprintf("event hub event %q (%d bytes, index %d) too large for an empty batch: %v", e.Name, e.Bytes, e.Index, e.Cause)
}

func (e *eventTooLargeError) Unwrap() error { return e.Cause }

// eventHubSender is the seam between Collector and the Azure SDK. Send must
// deliver every event in events as one or more batches (splitting when a
// batch fills, mirroring the SDK's own documented usage pattern) and return
// a non-nil error if any part of the delivery failed — an *eventTooLargeError
// when a single event can never fit. MaxMessageBytes is the largest single
// message the transport will accept, learned from the transport itself.
type eventHubSender interface {
	Send(ctx context.Context, events []Event) error
	MaxMessageBytes(ctx context.Context) (int, error)
	Close(ctx context.Context) error
}

// azureEventHubSender is the production eventHubSender, backed by a real
// azeventhubs.ProducerClient. One instance is created per Collector (not per
// flush), so the AMQP connection is reused across flush ticks rather than
// renegotiated on every send.
type azureEventHubSender struct {
	client   *azeventhubs.ProducerClient
	maxBytes atomic.Int64
}

// newAzureEventHubSender builds the SDK client from a connection string.
// eventHubName is required unless connectionString already carries an
// EntityPath (see azeventhubs.NewProducerClientFromConnectionString).
func newAzureEventHubSender(connectionString, eventHubName string) (*azureEventHubSender, error) {
	client, err := azeventhubs.NewProducerClientFromConnectionString(connectionString, eventHubName, nil)
	if err != nil {
		return nil, fmt.Errorf("event hub producer client: %w", err)
	}
	return &azureEventHubSender{client: client}, nil
}

// MaxMessageBytes returns the link's negotiated maximum message size,
// probing it on first call and caching the result for the life of the
// sender. The SDK does not expose the value directly, but it refuses to
// build a batch whose MaxBytes exceeds it, so the exact limit is found by a
// binary search over that refusal — local batch construction only, no
// network round-trips once the link is open, and no parsing of error text.
func (s *azureEventHubSender) MaxMessageBytes(ctx context.Context) (int, error) {
	if cached := s.maxBytes.Load(); cached > 0 {
		return int(cached), nil
	}
	max, err := probeLinkMaxMessageBytes(func(n uint64) error {
		_, err := s.client.NewEventDataBatch(ctx, &azeventhubs.EventDataBatchOptions{MaxBytes: n})
		return err
	})
	if err != nil {
		return 0, err
	}
	s.maxBytes.Store(int64(max))
	utils.LogWithFields(utils.LevelInfo, "telemetry", "event hub link max message size negotiated", map[string]any{
		"max_bytes": max,
	})
	return max, nil
}

// probeLinkMaxMessageBytes finds the largest n for which try(n) succeeds,
// assuming try is monotonic (succeeds below the limit, fails above). A
// failure at the smallest probe means the link itself is unavailable and is
// returned as the error. The result is re-verified before it is trusted, so
// a link that dropped mid-search is reported as an error rather than as a
// wrong limit.
func probeLinkMaxMessageBytes(try func(n uint64) error) (int, error) {
	if err := try(1); err != nil {
		return 0, fmt.Errorf("event hub link unavailable for max message size negotiation: %w", err)
	}
	lo, hi := uint64(1), uint64(defaultEventHubMaxMessageBytes)
	for try(hi) == nil {
		lo = hi
		if hi >= probeMaxMessageCeiling {
			break
		}
		hi *= 2
	}
	for hi-lo > 1 {
		mid := lo + (hi-lo)/2
		if try(mid) == nil {
			lo = mid
		} else {
			hi = mid
		}
	}
	if err := try(lo); err != nil {
		return 0, fmt.Errorf("event hub max message size negotiation did not converge (link changed mid-probe): %w", err)
	}
	return int(lo), nil
}

// Send packs events into one or more EventDataBatch instances and sends
// each as it fills, following the SDK's documented batching pattern: keep
// adding to the current batch until AddEventData reports
// ErrEventDataTooLarge, then send what's accumulated and start a fresh batch
// for the event that didn't fit. A single event too large even for an empty
// batch is returned as *eventTooLargeError so the caller can quarantine it
// and continue — the size contract in telemetry_oversize.go is meant to make
// that unreachable, and this is the backstop if the two ever disagree.
func (s *azureEventHubSender) Send(ctx context.Context, events []Event) error {
	if len(events) == 0 {
		return nil
	}

	batch, err := s.client.NewEventDataBatch(ctx, nil)
	if err != nil {
		return fmt.Errorf("event hub new batch: %w", err)
	}

	for i, event := range events {
		body, marshalErr := json.Marshal(event)
		if marshalErr != nil {
			return fmt.Errorf("event hub marshal event %q: %w", event.Name, marshalErr)
		}
		ed := &azeventhubs.EventData{Body: body}

		addErr := batch.AddEventData(ed, nil)
		if addErr == nil {
			continue
		}
		if !errors.Is(addErr, azeventhubs.ErrEventDataTooLarge) {
			return fmt.Errorf("event hub add event: %w", addErr)
		}
		if batch.NumEvents() == 0 {
			return &eventTooLargeError{Index: i, Bytes: len(body), Name: event.Name, Cause: addErr}
		}
		if sendErr := s.client.SendEventDataBatch(ctx, batch, nil); sendErr != nil {
			return fmt.Errorf("event hub send batch: %w", sendErr)
		}
		batch, err = s.client.NewEventDataBatch(ctx, nil)
		if err != nil {
			return fmt.Errorf("event hub new batch: %w", err)
		}
		if addErr := batch.AddEventData(ed, nil); addErr != nil {
			if errors.Is(addErr, azeventhubs.ErrEventDataTooLarge) {
				return &eventTooLargeError{Index: i, Bytes: len(body), Name: event.Name, Cause: addErr}
			}
			return fmt.Errorf("event hub add event after new batch: %w", addErr)
		}
	}

	if batch.NumEvents() > 0 {
		if err := s.client.SendEventDataBatch(ctx, batch, nil); err != nil {
			return fmt.Errorf("event hub send final batch: %w", err)
		}
	}
	return nil
}

// Close releases the underlying AMQP connection.
func (s *azureEventHubSender) Close(ctx context.Context) error {
	return s.client.Close(ctx)
}

// hasEventHubTarget mirrors hasHTTPTarget/hasOtelTarget in telemetry.go.
func hasEventHubTarget(targets []string) bool {
	for _, t := range targets {
		if t == "eventhub" {
			return true
		}
	}
	return false
}

// setupEventHubTarget wires the "eventhub" target into a newly-constructed
// Collector: builds the SDK-backed sender and the shared retry queue. Called
// once from NewCollector when "eventhub" is configured. A sender that fails
// to construct (bad connection string) leaves c.eventHubSender nil —
// deliverToEventHub then fails loudly on every attempt rather than silently
// dropping events, and the retry queue still exists so nothing already
// buffered is lost once the operator fixes the connection string and
// restarts.
func setupEventHubTarget(c *Collector, config types.TelemetryConfig) {
	mode, value := resolveEventHubCredentialMode(config)
	sender, err := buildEventHubSender(mode, value, config)
	if err != nil {
		utils.LogWithFields(utils.LevelError, "telemetry", "event hub producer client creation failed", map[string]any{
			"error": err.Error(), "event_hub_name": config.EventHubName, "credential_mode": string(mode),
		})
	} else {
		c.eventHubSender = sender
		utils.LogWithFields(utils.LevelInfo, "telemetry", "event hub target ready", map[string]any{
			"event_hub_name": config.EventHubName, "credential_mode": string(mode),
			"namespace": config.EventHubNamespace,
		})
	}

	policy, err := resolveOversizePolicy(config.OversizeEventPolicy)
	if err != nil {
		// A misconfigured policy falls back to the least-lossy one, loudly:
		// segmenting an event the operator wanted quarantined still delivers
		// it, whereas the reverse would silently withhold content.
		utils.LogWithFields(utils.LevelError, "telemetry", "oversize event policy invalid; using segment", map[string]any{
			"configured": config.OversizeEventPolicy, "error": err.Error(),
		})
		policy = oversizePolicySegment
	}
	c.eventHubOversize = policy
	c.eventHubMaxOverride = config.EventHubMaxMessageBytes
	utils.LogWithFields(utils.LevelInfo, "telemetry", "event hub size contract resolved", map[string]any{
		"oversize_policy": string(policy), "max_message_bytes_override": config.EventHubMaxMessageBytes,
	})

	// The queue path is derived from the credential value and hub name so two
	// differently-targeted collectors never share a file. The value may be a
	// secret, and retryQueuePath hashes what it is given rather than storing
	// it, so no credential reaches the filename.
	c.eventHubRetry = newRetryQueue(
		"eventhub",
		retryQueuePath("eventhub", config.FilePath, value+"|"+config.EventHubName),
		config.EventHubRetryQueueMaxMB,
		config.RetryQueueSoftWarnMB,
		config.RetryQueueStuckAfterMinutes,
		c.deliverToEventHub,
	)
}

// buildEventHubSender constructs the producer for the resolved credential
// mode. A "none" mode is an error rather than a silent no-op: the operator
// asked for the "eventhub" target, so having no way to reach one is a
// misconfiguration they need told about, not a target to quietly skip.
func buildEventHubSender(mode eventHubCredentialMode, value string, config types.TelemetryConfig) (*azureEventHubSender, error) {
	switch mode {
	case credentialModeEnvConnectionString, credentialModeConfigConnectionString:
		return newAzureEventHubSender(value, config.EventHubName)
	case credentialModeToken:
		return newTokenAuthEventHubSender(value, config.EventHubName, eventHubTokenScope(config), config.EventHubTokenAudience)
	default:
		return nil, fmt.Errorf("event hub target configured with no credential: set eventHubNamespace (token auth, no secret) or eventHubConnectionString, or export %s", EventHubConnectionStringEnv)
	}
}

// newTokenAuthEventHubSender builds a producer that authenticates with the
// engine's own identity instead of a shared secret. See
// telemetry_eventhub_credential.go for why this is the preferred path.
func newTokenAuthEventHubSender(namespace, eventHubName, scope, audience string) (*azureEventHubSender, error) {
	if eventHubName == "" {
		return nil, fmt.Errorf("event hub producer client: eventHubName is required when authenticating by namespace")
	}
	cred := &engineTokenCredential{scope: scope, audience: audience}
	client, err := azeventhubs.NewProducerClient(namespace, eventHubName, cred, nil)
	if err != nil {
		return nil, fmt.Errorf("event hub producer client (token auth): %w", err)
	}
	return &azureEventHubSender{client: client}, nil
}

// eventHubMaxMessageBytes resolves the size the contract is enforced
// against: an explicit operator override wins, otherwise the link's
// negotiated maximum, otherwise the published default — each fallback
// logged, because a wrong limit here either quarantines deliverable events
// or lets undeliverable ones through.
func (c *Collector) eventHubMaxMessageBytes(ctx context.Context) int {
	if c.eventHubMaxOverride > 0 {
		return c.eventHubMaxOverride
	}
	max, err := c.eventHubSender.MaxMessageBytes(ctx)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, "telemetry", "event hub max message size not negotiated; using published default", map[string]any{
			"error": err.Error(), "default_bytes": defaultEventHubMaxMessageBytes,
		})
		return defaultEventHubMaxMessageBytes
	}
	return max
}

// deliverToEventHub is the "eventhub" target's deliverFunc, used directly by
// flushEventHubTarget and indirectly (via c.eventHubRetry) by drainAndRetry.
// It enforces the size contract first — segmenting or quarantining per
// policy — then sends, and returns the events still owed on failure in their
// fitted form so the retry queue only ever holds deliverable messages and a
// quarantined event is never quarantined twice.
//
// A nil sender (producer client construction failed at startup) fails
// loudly rather than silently discarding — see setupEventHubTarget.
func (c *Collector) deliverToEventHub(events []Event) ([]Event, error) {
	if c.eventHubSender == nil {
		return events, fmt.Errorf("event hub sender not configured (producer client creation failed at startup)")
	}
	ctx, cancel := context.WithTimeout(context.Background(), eventHubSendTimeoutFor(events))
	defer cancel()

	fit, rejected := fitEvents(events, c.eventHubMaxMessageBytes(ctx), c.eventHubOversize)
	if len(rejected) > 0 {
		c.eventHubRetry.quarantineEvents(rejected)
	}
	for len(fit) > 0 {
		err := c.eventHubSender.Send(ctx, fit)
		if err == nil {
			return nil, nil
		}
		var tooLarge *eventTooLargeError
		if !errors.As(err, &tooLarge) || tooLarge.Index >= len(fit) {
			return fit, err
		}
		// The fit check and the link disagreed on one event. Everything
		// before it was delivered; quarantine it and resume after it.
		utils.LogWithFields(utils.LevelError, "telemetry", "event hub rejected an event the size contract accepted; quarantining it", map[string]any{
			"event": tooLarge.Name, "bytes": tooLarge.Bytes, "index": tooLarge.Index, "error": err.Error(),
		})
		c.eventHubRetry.quarantineEvents([]rejectedEvent{{Event: fit[tooLarge.Index], Bytes: tooLarge.Bytes, Reason: err.Error()}})
		fit = fit[tooLarge.Index+1:]
	}
	return nil, nil
}

// flushEventHubTarget is Collector.Flush's "eventhub" case, extracted here
// to keep telemetry.go under the file-size cap. Root-cause durable delivery,
// same shape as the "http" case: a failed send persists the still-owed
// events to the on-disk retry queue instead of discarding them.
// c.eventHubRetry is non-nil whenever "eventhub" is configured (see
// setupEventHubTarget).
func flushEventHubTarget(c *Collector, events []Event) error {
	remaining, err := c.deliverToEventHub(events)
	if c.eventHubRetry != nil {
		if err != nil {
			if len(remaining) > 0 {
				c.eventHubRetry.enqueue(remaining)
			}
			c.eventHubRetry.reportHealth(false, err.Error())
		} else {
			// Report the healthy case too, so a consumer sees recovery and
			// not only escalation — a backlog that drained is exactly the
			// transition an operator watching an outage is waiting for.
			c.eventHubRetry.reportHealth(true, "")
		}
	}
	return err
}

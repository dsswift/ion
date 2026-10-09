package main

import (
	"bytes"
	"crypto/ecdsa"
	"crypto/x509"
	"encoding/json"
	"encoding/pem"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

const (
	apnsProductionURL = "https://api.push.apple.com"
	apnsSandboxURL    = "https://api.sandbox.push.apple.com"
	tokenTTL          = 50 * time.Minute // Apple requires refresh within 60 min
)

// ErrQueueFull is returned by Send when the push queue is at capacity.
var ErrQueueFull = errors.New("apns push queue full")

// apnsError is a typed error returned by sendAsync. It carries a stable
// reason string used in logs and on the wire (relay:push-failed frame).
type apnsError struct {
	reason string
	err    error
}

func (e *apnsError) Error() string { return e.err.Error() }
func (e *apnsError) Unwrap() error { return e.err }

// newAPNsError wraps an underlying error with a classified reason.
func newAPNsError(reason string, err error) *apnsError {
	return &apnsError{reason: reason, err: err}
}

// classifyAPNsStatus maps an APNs HTTP status code to a stable reason string
// used both in logs and on the wire (relay:push-failed frame).
func classifyAPNsStatus(statusCode int) string {
	switch {
	case statusCode == 400 || statusCode == 403 || statusCode == 410:
		return "invalid_token"
	case statusCode == 429 || statusCode >= 500:
		return "transient"
	default:
		return "transient"
	}
}

// pushRequest holds the parameters for a single push notification.
type pushRequest struct {
	deviceToken string
	env         string // APNs environment that issued deviceToken; "" = pusher default
	title       string
	body        string
	kind        string // resource kind for deep-link routing on the client
	resourceId  string // resource ID for deep-link routing on the client
	channelId   string // relay channel ID (pairing identity for multi-device routing)
	tabId       string // desktop tab ID (conversation routing on the client)
	// traceparent is the doorbell's W3C trace context, copied into the APNs
	// payload so the phone's push.open span joins the server's trace. Empty
	// when the doorbell carried none.
	traceparent string

	// onFailure is called with a stable reason string when the push fails.
	// It is optional (nil means no callback).
	onFailure func(reason string)

	// enqueuedAt is when Enqueue accepted the request; the worker derives
	// queue_wait_ms and duration_ms from it.
	enqueuedAt time.Time
}

// APNsPusher sends push notifications via Apple's HTTP/2 APNs API.
type APNsPusher struct {
	client  *http.Client
	baseURL string // default endpoint, for a token whose environment is unknown
	// envURLs maps an environment to its endpoint. A missing entry falls back
	// to baseURL, which is how tests aim every push at one fake server.
	envURLs map[string]string
	keyID   string
	teamID  string
	topic   string // apns-topic header: the client app's bundle ID (APNS_TOPIC env)
	key     *ecdsa.PrivateKey

	mu          sync.Mutex
	cachedToken string
	tokenExpiry time.Time

	queue chan pushRequest

	// metrics receives queue depth, outcome latency, and drops. Nil-safe.
	metrics *relayMetrics
}

// newAPNsTransport builds the transport every APNs request goes out on. APNs
// speaks HTTP/2 only, so the transport must negotiate it even when a caller
// supplies its own TLS config, which turns the automatic upgrade off.
func newAPNsTransport() *http.Transport {
	return &http.Transport{
		ForceAttemptHTTP2:   true,
		TLSHandshakeTimeout: 10 * time.Second,
		IdleConnTimeout:     90 * time.Second,
	}
}

// NewAPNsPusher builds a pusher from the .p8 key's PEM bytes.
func NewAPNsPusher(keyData []byte, keyID, teamID, topic string) (*APNsPusher, error) {
	if topic == "" {
		return nil, fmt.Errorf("APNs topic is required (set APNS_TOPIC to the iOS app bundle ID)")
	}

	block, _ := pem.Decode(keyData)
	if block == nil {
		return nil, fmt.Errorf("invalid PEM in APNs key file")
	}

	parsedKey, err := x509.ParsePKCS8PrivateKey(block.Bytes)
	if err != nil {
		return nil, fmt.Errorf("parse APNs key: %w", err)
	}

	ecKey, ok := parsedKey.(*ecdsa.PrivateKey)
	if !ok {
		return nil, fmt.Errorf("APNs key is not ECDSA")
	}

	client := &http.Client{Transport: newAPNsTransport(), Timeout: 30 * time.Second}

	// The default endpoint serves a phone that did not report its token's
	// environment. A phone that did is routed by endpoint() instead.
	baseURL := apnsSandboxURL
	if os.Getenv("APNS_PRODUCTION") == "1" {
		baseURL = apnsProductionURL
	}

	return &APNsPusher{
		client:  client,
		baseURL: baseURL,
		envURLs: map[string]string{apnsEnvSandbox: apnsSandboxURL, apnsEnvProduction: apnsProductionURL},
		keyID:   keyID,
		teamID:  teamID,
		topic:   topic,
		key:     ecKey,
		queue:   make(chan pushRequest, 64),
	}, nil
}

func (p *APNsPusher) getToken() (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()

	if p.cachedToken != "" && time.Now().Before(p.tokenExpiry) {
		return p.cachedToken, nil
	}

	now := time.Now()
	token := jwt.NewWithClaims(jwt.SigningMethodES256, jwt.MapClaims{
		"iss": p.teamID,
		"iat": now.Unix(),
	})
	token.Header["kid"] = p.keyID

	signed, err := token.SignedString(p.key)
	if err != nil {
		return "", fmt.Errorf("sign APNs token: %w", err)
	}

	p.cachedToken = signed
	p.tokenExpiry = now.Add(tokenTTL)
	return signed, nil
}

type apnsPayload struct {
	Aps           apsPayload `json:"aps"`
	IonKind       string     `json:"ionKind,omitempty"`
	IonResourceId string     `json:"ionResourceId,omitempty"`
	IonChannelId  string     `json:"ionChannelId,omitempty"`
	IonTabId      string     `json:"ionTabId,omitempty"`
	// Traceparent is the doorbell's trace context (W3C), when it had one.
	Traceparent string `json:"traceparent,omitempty"`
}

type apsPayload struct {
	Alert            apsAlert `json:"alert"`
	Sound            string   `json:"sound,omitempty"`
	Category         string   `json:"category,omitempty"`
	ContentAvailable int      `json:"content-available,omitempty"`
}

type apsAlert struct {
	Title string `json:"title"`
	Body  string `json:"body"`
}

// Send enqueues a push notification. Returns ErrQueueFull if the queue is at
// capacity. The onFailure callback from SendWithNotify is not invoked on a
// queue-full drop — callers using SendWithNotify must check the return error
// and invoke the callback themselves when it is non-nil.
func (p *APNsPusher) Send(device apnsDevice, title, body, kind, resourceId, channelId, tabId string) error {
	return p.SendWithNotify(device, title, body, kind, resourceId, channelId, tabId, nil)
}

// SendWithNotify enqueues a push notification and registers an optional
// callback that is invoked with a stable reason string if the push fails at
// any stage (queue full, token error, transport error, or a non-200 APNs
// response). Callers that do not need failure notification may use Send instead.
func (p *APNsPusher) SendWithNotify(device apnsDevice, title, body, kind, resourceId, channelId, tabId string, onFailure func(reason string)) error {
	return p.Enqueue(pushRequest{
		deviceToken: device.Token,
		env:         device.Env,
		title:       title,
		body:        body,
		kind:        kind,
		resourceId:  resourceId,
		channelId:   channelId,
		tabId:       tabId,
		onFailure:   onFailure,
	})
}

// Enqueue hands a fully built request to the worker. It stamps enqueuedAt
// and returns ErrQueueFull when the queue is at capacity; the caller then
// invokes req.onFailure itself.
func (p *APNsPusher) Enqueue(req pushRequest) error {
	req.enqueuedAt = time.Now()
	select {
	case p.queue <- req:
		p.metrics.apnsQueued(len(p.queue))
		return nil
	default:
		p.metrics.apnsDroppedPush()
		logger.Warn("APNs push queue full", "tag", "relay.apns.error",
			"kind", req.kind, "resource_id", req.resourceId, "queue_depth", len(p.queue))
		return ErrQueueFull
	}
}

// Start launches a single background worker that drains the push queue.
func (p *APNsPusher) Start() {
	go func() {
		for req := range p.queue {
			p.metrics.apnsQueued(len(p.queue))
			err := p.sendAsync(req)
			outcome := apnsOutcomeDelivered
			if err != nil {
				outcome = "transient" // default when classification is unavailable
				var apnsErr *apnsError
				if errors.As(err, &apnsErr) {
					outcome = apnsErr.reason
				}
			}
			if !req.enqueuedAt.IsZero() {
				p.metrics.apnsFinished(outcome, time.Since(req.enqueuedAt))
			}
			if err != nil && req.onFailure != nil {
				req.onFailure(outcome)
			}
		}
	}()
}

// sendAsync executes a single APNs push synchronously (called from the worker
// goroutine). Returns nil on HTTP 200; otherwise returns a classified *apnsError.
func (p *APNsPusher) sendAsync(req pushRequest) error {
	startedAt := time.Now()
	// timing is appended to every outcome line: queue_wait_ms is enqueue to
	// worker pickup, duration_ms is enqueue to this outcome. A request built
	// without Enqueue (a direct test call) reports zero wait.
	timing := func() []any {
		wait := time.Duration(0)
		total := time.Since(startedAt)
		if !req.enqueuedAt.IsZero() {
			wait = startedAt.Sub(req.enqueuedAt)
			total = time.Since(req.enqueuedAt)
		}
		return []any{"queue_wait_ms", durationMS(wait), "duration_ms", durationMS(total)}
	}
	fail := func(reason string, err error, extra ...any) error {
		args := append([]any{"tag", "relay.apns.error", "err", err, "reason", reason,
			"kind", req.kind, "resource_id", req.resourceId}, extra...)
		logger.Error("APNs push failed", append(args, timing()...)...)
		return newAPNsError(reason, err)
	}

	token, err := p.getToken()
	if err != nil {
		return fail("token", fmt.Errorf("apns token: %w", err))
	}

	payload := apnsPayload{
		Aps: apsPayload{
			Alert: apsAlert{
				Title: req.title,
				Body:  req.body,
			},
			Sound:            "default",
			Category:         "PERMISSION_REQUEST",
			ContentAvailable: 1,
		},
		IonKind:       req.kind,
		IonResourceId: req.resourceId,
		IonChannelId:  req.channelId,
		IonTabId:      req.tabId,
		Traceparent:   req.traceparent,
	}

	data, err := json.Marshal(payload)
	if err != nil {
		return fail("marshal", fmt.Errorf("apns marshal: %w", err))
	}

	url := fmt.Sprintf("%s/3/device/%s", p.endpoint(req.env), req.deviceToken)
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		return fail("request", fmt.Errorf("apns request: %w", err))
	}

	httpReq.Header.Set("Authorization", "bearer "+token)
	httpReq.Header.Set("apns-topic", p.topic)
	httpReq.Header.Set("apns-push-type", "alert")
	httpReq.Header.Set("apns-priority", "10")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		return fail("transport", fmt.Errorf("apns transport: %w", err))
	}
	defer func() { resp.Body.Close() }() //nolint:errcheck // response body close

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body) //nolint:errcheck // best-effort read of an error-response body
		reason := classifyAPNsStatus(resp.StatusCode)
		return fail(reason, fmt.Errorf("apns response: status %d reason %s", resp.StatusCode, reason),
			"status", resp.StatusCode, "body", string(respBody), "apns_env", req.env)
	}

	logger.Info("APNs push delivered", append([]any{"tag", "relay.apns.delivered",
		"status", resp.StatusCode, "kind", req.kind, "resource_id", req.resourceId,
		"channel_id", req.channelId, "tab_id", req.tabId, "apns_env", req.env,
		"traced", req.traceparent != ""}, timing()...)...)
	return nil
}

// endpoint returns the APNs host for a token from env, or the default when
// the phone did not report its environment.
func (p *APNsPusher) endpoint(env string) string {
	if url, ok := p.envURLs[env]; ok {
		return url
	}
	return p.baseURL
}

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
	"golang.org/x/net/http2"
)

const (
	apnsProductionURL = "https://api.push.apple.com"
	apnsSandboxURL    = "https://api.sandbox.push.apple.com"
	apnsTopic         = "com.sprague.ion.mobile"
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
	title       string
	body        string
	kind        string // resource kind for deep-link routing on the client
	resourceId  string // resource ID for deep-link routing on the client

	// onFailure is called with a stable reason string when the push fails.
	// It is optional (nil means no callback).
	onFailure func(reason string)
}

// APNsPusher sends push notifications via Apple's HTTP/2 APNs API.
type APNsPusher struct {
	client  *http.Client
	baseURL string
	keyID   string
	teamID  string
	key     *ecdsa.PrivateKey

	mu          sync.Mutex
	cachedToken string
	tokenExpiry time.Time

	queue chan pushRequest
}

func NewAPNsPusher(keyPath, keyID, teamID string) (*APNsPusher, error) {
	keyData, err := os.ReadFile(keyPath)
	if err != nil {
		return nil, fmt.Errorf("read APNs key: %w", err)
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

	transport := &http2.Transport{}
	client := &http.Client{Transport: transport, Timeout: 30 * time.Second}

	// Use sandbox for development; production in release builds.
	baseURL := apnsSandboxURL
	if os.Getenv("APNS_PRODUCTION") == "1" {
		baseURL = apnsProductionURL
	}

	return &APNsPusher{
		client:  client,
		baseURL: baseURL,
		keyID:   keyID,
		teamID:  teamID,
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
func (p *APNsPusher) Send(deviceToken, title, body, kind, resourceId string) error {
	return p.SendWithNotify(deviceToken, title, body, kind, resourceId, nil)
}

// SendWithNotify enqueues a push notification and registers an optional
// callback that is invoked with a stable reason string if the push fails at
// any stage (queue full, token error, transport error, or a non-200 APNs
// response). Callers that do not need failure notification may use Send instead.
func (p *APNsPusher) SendWithNotify(deviceToken, title, body, kind, resourceId string, onFailure func(reason string)) error {
	req := pushRequest{
		deviceToken: deviceToken,
		title:       title,
		body:        body,
		kind:        kind,
		resourceId:  resourceId,
		onFailure:   onFailure,
	}
	select {
	case p.queue <- req:
		return nil
	default:
		logger.Warn("APNs push queue full", "tag", "relay.apns.error",
			"kind", kind, "resource_id", resourceId)
		return ErrQueueFull
	}
}

// Start launches a single background worker that drains the push queue.
func (p *APNsPusher) Start() {
	go func() {
		for req := range p.queue {
			if err := p.sendAsync(req); err != nil {
				if req.onFailure != nil {
					reason := "transient" // default when classification is unavailable
					var apnsErr *apnsError
					if errors.As(err, &apnsErr) {
						reason = apnsErr.reason
					}
					req.onFailure(reason)
				}
			}
		}
	}()
}

// sendAsync executes a single APNs push synchronously (called from the worker
// goroutine). Returns nil on HTTP 200; otherwise returns a classified *apnsError.
func (p *APNsPusher) sendAsync(req pushRequest) error {
	token, err := p.getToken()
	if err != nil {
		logger.Error("APNs token error", "tag", "relay.apns.error", "err", err,
			"kind", req.kind, "resource_id", req.resourceId)
		return newAPNsError("token", fmt.Errorf("apns token: %w", err))
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
	}

	data, err := json.Marshal(payload)
	if err != nil {
		logger.Error("APNs marshal error", "tag", "relay.apns.error", "err", err,
			"kind", req.kind, "resource_id", req.resourceId)
		return newAPNsError("marshal", fmt.Errorf("apns marshal: %w", err))
	}

	url := fmt.Sprintf("%s/3/device/%s", p.baseURL, req.deviceToken)
	httpReq, err := http.NewRequest("POST", url, bytes.NewReader(data))
	if err != nil {
		logger.Error("APNs request error", "tag", "relay.apns.error", "err", err,
			"kind", req.kind, "resource_id", req.resourceId)
		return newAPNsError("request", fmt.Errorf("apns request: %w", err))
	}

	httpReq.Header.Set("Authorization", "bearer "+token)
	httpReq.Header.Set("apns-topic", apnsTopic)
	httpReq.Header.Set("apns-push-type", "alert")
	httpReq.Header.Set("apns-priority", "10")

	resp, err := p.client.Do(httpReq)
	if err != nil {
		logger.Error("APNs send error", "tag", "relay.apns.error", "err", err,
			"kind", req.kind, "resource_id", req.resourceId)
		return newAPNsError("transport", fmt.Errorf("apns transport: %w", err))
	}
	defer func() { resp.Body.Close() }() //nolint:errcheck // response body close

	if resp.StatusCode != http.StatusOK {
		respBody, _ := io.ReadAll(resp.Body) //nolint:errcheck // best-effort read of an error-response body
		reason := classifyAPNsStatus(resp.StatusCode)
		logger.Error("APNs response error", "tag", "relay.apns.error",
			"status", resp.StatusCode, "body", string(respBody),
			"reason", reason, "kind", req.kind, "resource_id", req.resourceId)
		return newAPNsError(reason, fmt.Errorf("apns response: status %d reason %s", resp.StatusCode, reason))
	}

	logger.Info("APNs push delivered", "tag", "relay.apns.delivered",
		"status", resp.StatusCode, "kind", req.kind, "resource_id", req.resourceId)
	return nil
}

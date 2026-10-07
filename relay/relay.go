package main

import (
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"sync"
	"time"

	"github.com/coder/websocket"
)

// Channel holds the two sides of a relay channel: the one server (ion) and
// the clients (mobile) of its pairing.
type Channel struct {
	mu  sync.Mutex
	ion *websocket.Conn
	// multi is whether the server on the channel joined as multi-client. It
	// then keeps one connection per client: the relay admits several
	// clients, names each to the server, and routes each server frame to
	// the client it names. Otherwise the channel holds one client and a
	// second join replaces the first.
	multi bool
	// mobiles are the clients on the channel, oldest first.
	mobiles []*mobilePeer
}

// Hub manages all active channels.
type Hub struct {
	mu       sync.RWMutex
	channels map[string]*Channel

	// trust holds server-announced trust per channel (manifest C7). Nil
	// disables the announce feature entirely -- every channel behaves as
	// before (org-wide OIDC/PSK only). Set by main() when constructing the
	// production Hub.
	trust *TrustStore

	// oidcRegistry lazily builds and caches per-issuer OIDC validators for
	// server-announced trust (manifest C7). Nil when RELAY_TRUSTED_ISSUERS
	// is unset -- announced trust then always refuses with
	// issuer_not_trusted, since no issuer can be validated.
	oidcRegistry *OIDCRegistry

	// Configurable timeouts and limits (set at construction, read-only after).
	WriteTimeout   time.Duration // forward write deadline (default 10s)
	PingInterval   time.Duration // keepalive ping interval (default 30s)
	PingTimeout    time.Duration // pong wait deadline (default 10s)
	MaxMessageSize int64         // read limit in bytes (default 12MB)

	// otlp records relay.forward spans for frames carrying a traceparent.
	// Nil when OTLP shipping is off.
	otlp *otlpShipper

	// metrics is the Prometheus set served on /metrics. Nil when
	// RELAY_METRICS_ENABLED=false; every method is nil-safe.
	metrics *relayMetrics
}

func NewHub() *Hub {
	return &Hub{
		channels:       make(map[string]*Channel),
		metrics:        newRelayMetrics(),
		trust:          NewTrustStore(),
		oidcRegistry:   NewOIDCRegistry(os.Getenv("RELAY_TRUSTED_ISSUERS")),
		WriteTimeout:   10 * time.Second,
		PingInterval:   30 * time.Second,
		PingTimeout:    10 * time.Second,
		MaxMessageSize: 12 * 1024 * 1024,
	}
}

func (h *Hub) getOrCreateChannel(id string) *Channel {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.channels[id]
	if !ok {
		ch = &Channel{}
		h.channels[id] = ch
	}
	return ch
}

func (h *Hub) removeIfEmpty(id string) {
	h.mu.Lock()
	defer h.mu.Unlock()
	ch, ok := h.channels[id]
	if !ok {
		return
	}
	ch.mu.Lock()
	empty := ch.ion == nil && len(ch.mobiles) == 0
	ch.mu.Unlock()
	if empty {
		delete(h.channels, id)
	}
}

func (h *Hub) CloseAll() {
	h.mu.Lock()
	defer h.mu.Unlock()
	for _, ch := range h.channels {
		ch.mu.Lock()
		if ch.ion != nil {
			ch.ion.CloseNow() //nolint:errcheck // connection teardown
		}
		for _, p := range ch.mobiles {
			p.conn.CloseNow() //nolint:errcheck // connection teardown
		}
		ch.mu.Unlock()
	}
	h.channels = make(map[string]*Channel)
}

// ChannelCount returns the number of active channels (used by tests).
func (h *Hub) ChannelCount() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.channels)
}

// EvictForeignMobile closes a mobile peer that is on channelID under an
// identity other than owner, and reports whether it closed one.
//
// A client may sit on a channel nobody owns yet. The moment the channel's own
// server claims it, a client from another account has no business there: it
// could not join now, so it does not stay.
func (h *Hub) EvictForeignMobile(channelID, owner string) bool {
	h.mu.RLock()
	ch, ok := h.channels[channelID]
	h.mu.RUnlock()
	if !ok {
		return false
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	kept := ch.mobiles[:0]
	evicted := false
	for _, p := range ch.mobiles {
		if p.ownerKey == "" || p.ownerKey == owner {
			kept = append(kept, p)
			continue
		}
		logger.Warn("oidc: closing a peer that is not the channel's owner",
			"tag", "relay.channel.evicted", "channel_id", channelID, "owner", owner)
		// CloseNow, not Close: a graceful close waits for the peer's close frame,
		// and this runs inside the claiming server's own upgrade request.
		p.conn.CloseNow() //nolint:errcheck // closing an evicted connection
		evicted = true
	}
	ch.mobiles = kept
	return evicted
}

// ChannelStatus returns whether the ion and mobile roles are connected for a channel.
func (h *Hub) ChannelStatus(channelID string) (ionConnected, mobileConnected bool) {
	h.mu.RLock()
	ch, ok := h.channels[channelID]
	h.mu.RUnlock()
	if !ok {
		return false, false
	}
	ch.mu.Lock()
	defer ch.mu.Unlock()
	return ch.ion != nil, len(ch.mobiles) > 0
}

// controlMessage is a relay-originated control frame.
type controlMessage struct {
	Type string `json:"type"`
}

// pushFailedControl is the wire shape for a relay:push-failed control frame.
// It is emitted back to the ion peer when an APNs push fails at any stage.
type pushFailedControl struct {
	Type       string `json:"type"`                 // "relay:push-failed"
	Reason     string `json:"reason"`               // no_token | push_unavailable | queue_full | invalid_token | transient | token | marshal | request | transport
	ResourceId string `json:"resourceId,omitempty"` // resource ID from the originating push message
}

// forwardAck is the wire shape for relay:forwarded / relay:peer-unavailable
// control frames sent back to the mobile peer after it sends a data frame.
// Seq echoes the outer WireMessage.seq so the mobile client can correlate
// the ACK with the frame it sent. The relay reads only the outer envelope
// and never inspects payload or ciphertext (encryption blindness).
type forwardAck struct {
	Type   string `json:"type"`             // "relay:forwarded" | "relay:peer-unavailable"
	Seq    int64  `json:"seq"`              // outer WireMessage seq from the mobile frame
	Reason string `json:"reason,omitempty"` // present on peer-unavailable: "no_peer" | "write_failed"
}

// wireEnvelope extracts only the outer WireMessage envelope fields the relay
// uses: seq for forward ACKs and the optional W3C traceparent for
// relay.forward spans (forward.go). The relay never reads deeper than this.
type wireEnvelope struct {
	Seq         int64  `json:"seq"`
	Traceparent string `json:"traceparent,omitempty"`
}

func sendControl(conn *websocket.Conn, msgType string, timeout time.Duration, log *slog.Logger) {
	msg, _ := json.Marshal(controlMessage{Type: msgType}) //nolint:errcheck // marshal of a trivial fixed struct cannot fail
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		log.Warn("sendControl error", "tag", "relay.control_error", "msg_type", msgType, "err", err)
	}
}

// sendControlPayload writes an arbitrary JSON-marshallable control frame to conn.
func sendControlPayload(conn *websocket.Conn, payload any, timeout time.Duration, log *slog.Logger) {
	msg, err := json.Marshal(payload)
	if err != nil {
		log.Error("sendControlPayload marshal error", "tag", "relay.control_error", "err", err)
		return
	}
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	if err := conn.Write(ctx, websocket.MessageText, msg); err != nil {
		log.Warn("sendControlPayload write error", "tag", "relay.control_error", "err", err)
	}
}

// HandleWebSocket upgrades the HTTP connection to WebSocket and runs the relay
// loop for channelID/role. identity is non-nil for OIDC-authenticated connections
// and nil for PSK connections. Token expiry enforcement applies only when
// identity.TokenExpiry is non-zero.
func (h *Hub) HandleWebSocket(w http.ResponseWriter, r *http.Request, channelID, role string, pusher *APNsPusher, identity *UserIdentity) {
	// Reject connections with an Origin header. Native apps (Ion desktop,
	// iOS) don't send Origin; browsers do. This prevents browser-based
	// cross-site WebSocket hijacking attacks against the relay.
	if r.Header.Get("Origin") != "" {
		http.Error(w, "Forbidden", http.StatusForbidden)
		return
	}

	sessionID := r.Header.Get("X-Ion-Session-Id")

	connLog := logger.With("channel_id", channelID, "role", role)
	if sessionID != "" {
		connLog = connLog.With("session_id", sessionID)
	}
	if identity != nil {
		connLog = connLog.With("subject", identity.Subject)
	}

	// Enable compression only for the desktop ("ion") role.  Apple's
	// URLSessionWebSocketTask offers permessage-deflate in the handshake
	// but its inflate implementation is broken for context-takeover mode,
	// causing immediate "Protocol error" disconnects on every received
	// frame.  Disabling compression for mobile avoids this.
	compressionMode := websocket.CompressionDisabled
	if role == "ion" {
		compressionMode = websocket.CompressionContextTakeover
	}

	conn, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		InsecureSkipVerify: true,
		CompressionMode:    compressionMode,
	})
	if err != nil {
		connLog.Warn("accept error", "tag", "relay.forward_error", "err", err)
		return
	}

	// Allow messages up to the configured max (default 12MB).
	conn.SetReadLimit(h.MaxMessageSize)

	ch := h.getOrCreateChannel(channelID)

	ch.mu.Lock()

	// Store the connection by role. A server replaces the server before it.
	// A client joins beside the others when the server is multi-client, and
	// replaces the one before it otherwise.
	var self *mobilePeer
	switch role {
	case "ion":
		if ch.ion != nil {
			ch.ion.Close(websocket.StatusGoingAway, "replaced") //nolint:errcheck // closing a replaced connection
			h.metrics.reconnected(role)
		}
		ch.ion = conn
		ch.multi = r.URL.Query().Get("multi") == "1"
		if !ch.multi && len(ch.mobiles) > 1 {
			// This server keeps one client: the newest stays.
			connLog.Info("server is not multi-client; keeping only the newest client",
				"tag", "relay.connect", "closed", len(ch.mobiles)-1)
			ch.closeMobilesLocked(ch.mobiles[len(ch.mobiles)-1])
		}
		// Tell every client the server is here, and a multi-client server
		// which clients are.
		for _, p := range ch.mobiles {
			sendControl(p.conn, "relay:peer-reconnected", h.WriteTimeout, connLog)
			if ch.multi {
				sendControlPayload(conn, peerControl{Type: controlPeerJoined, Peer: p.id}, h.WriteTimeout, connLog)
			}
		}
	case "mobile":
		if !ch.multi {
			if len(ch.mobiles) > 0 {
				h.metrics.reconnected(role)
			}
			ch.closeMobilesLocked(nil)
		}
		self = &mobilePeer{id: newPeerID(), conn: conn}
		if identity != nil {
			self.ownerKey = identity.OwnerKey
		}
		ch.mobiles = append(ch.mobiles, self)
		connLog = connLog.With("peer", self.id)
		if ch.ion != nil {
			if ch.multi {
				sendControlPayload(ch.ion, peerControl{Type: controlPeerJoined, Peer: self.id}, h.WriteTimeout, connLog)
			} else {
				sendControl(ch.ion, "relay:peer-reconnected", h.WriteTimeout, connLog)
			}
		}
	}
	multi := ch.multi

	ch.mu.Unlock()

	// Mobile URLSession considers the socket usable only after its first inbound
	// frame. When LAN is preferred, desktop application traffic stays on LAN and
	// a new mobile relay socket would otherwise remain silent until its deadline.
	// Do not send this to the ion role: existing desktop clients treat control
	// frames as peer-state signals and do not need an upgrade confirmation.
	if self != nil {
		sendControlPayload(conn, peerControl{Type: "relay:connected", Peer: self.id}, h.WriteTimeout, connLog)
	}

	connLog.Info("client connected", "tag", "relay.connect", "multi", multi)
	h.metrics.connectionOpened(role)

	// Start keepalive pings. Essential for public internet deployments where
	// NAT timeouts, load balancer idle limits, and mobile network switches
	// can silently kill connections.
	done := make(chan struct{})
	go ping(conn, done, h.PingInterval, h.PingTimeout, h.metrics, connLog)

	// Token expiry enforcement: for OIDC connections with a finite exp, close
	// the connection at expiry time with close code 4401.
	if identity != nil && !identity.TokenExpiry.IsZero() {
		go watchTokenExpiry(conn, done, identity, channelID, role, connLog)
	}

	// Read loop: forward messages to the peer. readStart is when the loop
	// last went back to conn.Read: the previous frame boundary, which is
	// where the next frame's span and read_ms begin.
	sawFirstIonFrame := false
	readStart := time.Now()
	for {
		msgType, data, err := conn.Read(context.Background())
		recvAt := time.Now()
		if err != nil {
			// Log the exit reason so a clean close is distinguishable from a
			// timeout or protocol error. websocket normal-closure is expected;
			// anything else explains an otherwise-mysterious disconnect.
			connLog.Info("read loop ended", "tag", "relay.disconnect", "role", role, "err", err)
			break
		}
		h.metrics.frameRead(forwardDirection(role), len(data))

		// Server-announced trust (manifest C7): the ion peer's FIRST frame
		// after upgrade may be a relay_announce, naming the issuer/audience/
		// scope (or pairing:true) that a later mobile/client join on this
		// channel is validated against, instead of the relay's own org-wide
		// OIDC/PSK. Checked only on the loop's first iteration and only for
		// the ion role -- a relay_announce is ion-internal signaling, never
		// forwarded to the mobile peer, and never expected again after the
		// first frame. Any first frame that is NOT a well-formed
		// relay_announce (every ion peer running code that predates this
		// feature) falls through to the ordinary forwarding path below
		// unchanged, so a legacy ion peer's first real message is never lost.
		if role == "ion" && h.trust != nil {
			isFirstFrame := !sawFirstIonFrame
			sawFirstIonFrame = true
			if isFirstFrame {
				if trust, ok := parseRelayAnnounce(data); ok {
					h.trust.Set(channelID, trust)
					connLog.Info("relay announce received",
						"tag", "relay.announce",
						"channel_id", channelID,
						"issuer", trust.Issuer,
						"audience", trust.Audience,
						"pairing", trust.Pairing)
					continue
				}
			}
		} else if role == "mobile" && h.trust != nil {
			// A relay_announce arriving from the mobile role is not part of
			// the protocol -- only an ion peer announces trust. Log and drop
			// it rather than forwarding ion-internal-shaped signaling data to
			// the ion peer as if it were an application frame.
			if _, ok := parseRelayAnnounce(data); ok {
				connLog.Warn("relay announce received from mobile role; ignored",
					"tag", "relay.announce", "channel_id", channelID)
				continue
			}
		}

		out := h.forwardFrame(ch, conn, role, self, channelID, inboundFrame{
			msgType: msgType, data: data, readStart: readStart, recvAt: recvAt,
		}, connLog)
		if out.peers == 0 && role == "ion" {
			if out.named {
				// The client this frame names has left; the server hears so in
				// its own relay:peer-left.
				connLog.Debug("frame for a client that left; dropped", "tag", "relay.forward_error")
			} else {
				h.handleDoorbell(ch, conn, pusher, channelID, data, connLog)
			}
		}
		readStart = time.Now()
	}

	// Cleanup on disconnect. A connection that was replaced is already off
	// the channel, and its leaving is not news to the other side.
	ch.mu.Lock()
	switch role {
	case "ion":
		if ch.ion == conn {
			ch.ion = nil
			for _, p := range ch.mobiles {
				sendControl(p.conn, "relay:peer-disconnected", h.WriteTimeout, connLog)
			}
		}
	case "mobile":
		if ch.removeMobileLocked(conn) && ch.ion != nil {
			if ch.multi {
				sendControlPayload(ch.ion, peerControl{Type: controlPeerLeft, Peer: self.id}, h.WriteTimeout, connLog)
			} else {
				sendControl(ch.ion, "relay:peer-disconnected", h.WriteTimeout, connLog)
			}
		}
	}
	ch.mu.Unlock()

	// Server-announced trust (manifest C7) is scoped to the ion peer that
	// announced it: when that peer leaves, its announcement leaves with it,
	// so a stale trust grant never outlives the connection that made it. A
	// reconnecting ion peer re-announces (or doesn't) on its own next
	// connection, per the normal first-frame path above.
	if role == "ion" && h.trust != nil {
		h.trust.Clear(channelID)
	}

	connLog.Info("client disconnected", "tag", "relay.disconnect")
	h.metrics.connectionClosed(role)
	h.removeIfEmpty(channelID)
	close(done)
	conn.CloseNow() //nolint:errcheck // connection teardown
}

// ping sends WebSocket pings at the configured interval to detect dead connections.
// If a pong is not received within pingTimeout, the connection is closed,
// which causes the read loop to exit. Each answered ping's round trip (sent
// to pong received) is observed on relay_ping_rtt_seconds.
func ping(conn *websocket.Conn, done <-chan struct{}, interval, pingTimeout time.Duration, metrics *relayMetrics, log *slog.Logger) {
	ticker := time.NewTicker(interval)
	defer ticker.Stop()
	for {
		select {
		case <-done:
			return
		case <-ticker.C:
			ctx, cancel := context.WithTimeout(context.Background(), pingTimeout)
			sentAt := time.Now()
			err := conn.Ping(ctx)
			cancel()
			if err == nil {
				metrics.pingRoundTrip(time.Since(sentAt))
			}
			if err != nil {
				// A keepalive ping timeout tears the connection down. Log the
				// reason before closing — this is often the one signal that
				// explains an otherwise-mysterious disconnect.
				log.Warn("keepalive ping failed; closing connection", "tag", "relay.ping_failed", "err", err)
				if closeErr := conn.CloseNow(); closeErr != nil {
					log.Debug("close after ping failure errored", "tag", "relay.ping_failed", "err", closeErr)
				}
				return
			}
		}
	}
}

// watchTokenExpiry closes the WebSocket connection with close code 4401 when
// the JWT token expires. It applies a 60-second leeway (waiting until
// expiry + 60s) to account for clock skew that was also accepted at validation.
// PSK connections never call this function (identity.TokenExpiry is zero).
func watchTokenExpiry(conn *websocket.Conn, done <-chan struct{}, identity *UserIdentity, channelID, role string, log *slog.Logger) {
	// Add 60s leeway matching the validation leeway so we don't disconnect
	// a connection whose token was accepted with leeway applied.
	fireAt := identity.TokenExpiry.Add(60 * time.Second)
	delay := time.Until(fireAt)
	if delay <= 0 {
		// Already expired (including leeway); close immediately.
		delay = 0
	}

	timer := time.NewTimer(delay)
	defer timer.Stop()

	select {
	case <-done:
		return
	case <-timer.C:
		log.Info("token expired; disconnecting client",
			"tag", "relay.token.expired_disconnect",
			"channel_id", channelID,
			"role", role,
			"subject", identity.Subject,
			"expired_at", identity.TokenExpiry)
		// Close code 4401 signals token expiry to the client.
		conn.Close(4401, "token_expired") //nolint:errcheck // connection teardown
	}
}

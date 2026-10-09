package main

// doorbell.go — what the relay does with a server frame when no client is
// connected to take it: if the outer envelope asks for a push, ring the
// phone through APNs; otherwise drop the frame. The push fields ride the
// envelope in plaintext beside the sealed payload (packages/shared/src/
// studio-wire/relay-envelope.ts, RelayPushMeta); the relay never opens the
// payload.

import (
	"encoding/json"
	"log/slog"

	"github.com/coder/websocket"
)

// relayMessage is the outer envelope's doorbell fields.
type relayMessage struct {
	Push             bool   `json:"push,omitempty"`
	PushTitle        string `json:"pushTitle,omitempty"`
	PushBody         string `json:"pushBody,omitempty"`
	NotifyKind       string `json:"notifyKind,omitempty"`
	NotifyResourceId string `json:"notifyResourceId,omitempty"`
	PushTabId        string `json:"pushTabId,omitempty"`
	// The phone's push address. The server owns it (the phone registered it
	// there) and sends it with every push; the relay keeps no address book.
	PushToken string `json:"pushToken,omitempty"`
	PushEnv   string `json:"pushEnv,omitempty"`
	// Traceparent is the server's trace for the doorbell. It goes into the
	// APNs payload so the phone's push.open span joins the same trace.
	Traceparent string `json:"traceparent,omitempty"`
}

// handleDoorbell runs for an ion frame that reached no client and named
// none. pusher is nil when the relay booted without APNs.
func (h *Hub) handleDoorbell(ch *Channel, conn *websocket.Conn, pusher *APNsPusher, channelID string, data []byte, log *slog.Logger) {
	var msg relayMessage
	if err := json.Unmarshal(data, &msg); err != nil {
		if pusher == nil {
			return
		}
		// A push-eligible frame that fails to unmarshal is silently skipped
		// otherwise: no push, no push-failed frame back to ion.
		log.Warn("push-eligible frame unmarshal failed", "tag", "relay.apns.error", "channel_id", channelID, "err", err)
		return
	}
	if !msg.Push {
		return
	}
	if pusher == nil {
		// No client and push disabled. Log so "why no notification" is
		// debuggable instead of a silent no-op.
		log.Warn("push requested but push is unavailable (relay booted without APNs)",
			"tag", "relay.apns.unavailable", "channel_id", channelID,
			"kind", msg.NotifyKind, "resource_id", msg.NotifyResourceId)
		sendControlPayload(conn, pushFailedControl{Type: "relay:push-failed", Reason: "push_unavailable", ResourceId: msg.NotifyResourceId}, h.WriteTimeout, log)
		return
	}

	env, envOK := parseAPNsEnv(msg.PushEnv)
	if !envOK {
		// Keep the push: the pusher's default environment may still be the
		// right one for this token.
		log.Warn("unknown pushEnv from server; using the relay default",
			"tag", "relay.apns.error", "channel_id", channelID, "apns_env", msg.PushEnv)
	}
	device := apnsDevice{Token: msg.PushToken, Env: env}
	if device.Token == "" {
		// The server sent no push address: the phone has not registered one
		// with it (an older app build), or the server predates owning push
		// addresses.
		log.Error("push skipped: the server sent no push address",
			"tag", "relay.apns.skipped_no_token", "channel_id", channelID,
			"kind", msg.NotifyKind, "resource_id", msg.NotifyResourceId)
		// The sender is the ion peer; tell it, so the push that did not
		// happen shows up in the server's log too.
		sendControlPayload(conn, pushFailedControl{Type: "relay:push-failed", Reason: "no_token", ResourceId: msg.NotifyResourceId}, h.WriteTimeout, log)
		return
	}

	title, body := msg.PushTitle, msg.PushBody
	if title == "" {
		title = "Ion needs your attention"
	}
	if body == "" {
		body = "Approval required"
	}
	resourceId := msg.NotifyResourceId
	traceparent := ""
	if _, ok := parseTraceparent(msg.Traceparent); ok {
		traceparent = msg.Traceparent
	} else if msg.Traceparent != "" {
		log.Debug("doorbell traceparent invalid; push carries none",
			"tag", "relay.trace", "channel_id", channelID, "resource_id", resourceId)
	}

	// The failure callback serves both the queue-full path (Enqueue's
	// return value) and the worker path (called after the APNs response).
	onFailure := func(reason string) {
		ch.mu.Lock()
		ionConn := ch.ion
		ch.mu.Unlock()
		if ionConn == nil {
			return
		}
		log.Info("emitting push-failed to ion peer", "tag", "relay.apns.push_failed", "reason", reason, "resource_id", resourceId)
		sendControlPayload(ionConn, pushFailedControl{Type: "relay:push-failed", Reason: reason, ResourceId: resourceId}, h.WriteTimeout, log)
	}

	req := pushRequest{
		deviceToken: device.Token,
		env:         device.Env,
		title:       title,
		body:        body,
		kind:        msg.NotifyKind,
		resourceId:  resourceId,
		channelId:   channelID,
		tabId:       msg.PushTabId,
		traceparent: traceparent,
		onFailure:   onFailure,
	}
	if err := pusher.Enqueue(req); err != nil {
		// Queue was full: report back to the ion peer immediately.
		onFailure("queue_full")
	}
}

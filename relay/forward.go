package main

// forward.go — the forwarding half of the read loop in relay.go: who a frame
// goes to, the relay.forward span around the writes, the metrics, and the
// mobile ACK. The relay reads only a frame's outer envelope; the sealed
// payload is never parsed. The one byte-level edit it makes is the outer
// traceparent's span id (rewriteTraceparent), so the receiver parents its
// own span under relay.forward instead of beside it.

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"time"

	"github.com/coder/websocket"
)

// forwardPeerIon names the server side on a span and in logs; mobile peers
// carry the id the relay minted at join.
const forwardPeerIon = "ion"

// forwardPeer is one destination of a frame.
type forwardPeer struct {
	id   string
	conn *websocket.Conn
}

// inboundFrame is one frame as the read loop received it. readStart is the
// previous frame boundary: the moment the loop went back to conn.Read.
type inboundFrame struct {
	msgType   websocket.MessageType
	data      []byte
	readStart time.Time
	recvAt    time.Time
}

// forwardOutcome is what forwardFrame did with a frame, for the read loop's
// no-peer branches.
type forwardOutcome struct {
	peers    int
	named    bool // an ion frame named one client (multi-client channel)
	writeErr error
}

// selectPeersLocked decides who a frame goes to and stamps a client's frame
// with its peer id on a multi-client channel. The channel lock must be held.
// A client's frame goes to the server. A server's frame goes to the client
// it names, or to every client when it names none.
func (ch *Channel) selectPeersLocked(role string, self *mobilePeer, data []byte, log *slog.Logger) ([]forwardPeer, []byte, bool) {
	var peers []forwardPeer
	named := false
	if role == "mobile" {
		if ch.ion != nil {
			peers = append(peers, forwardPeer{id: forwardPeerIon, conn: ch.ion})
		}
		if ch.multi && self != nil {
			if stamped, ok := stampPeer(data, self.id); ok {
				data = stamped
			} else {
				log.Warn("client frame is not a JSON object; forwarded unstamped", "tag", "relay.forward_error")
			}
		}
		return peers, data, named
	}
	var to peerEnvelope
	if ch.multi && json.Unmarshal(data, &to) == nil && to.Peer != "" {
		named = true
		if p := ch.mobileLocked(to.Peer); p != nil {
			peers = append(peers, forwardPeer{id: p.id, conn: p.conn})
		}
		return peers, data, named
	}
	for _, p := range ch.mobiles {
		peers = append(peers, forwardPeer{id: p.id, conn: p.conn})
	}
	return peers, data, named
}

// forwardFrame routes one frame to its peers, records the relay.forward span
// and metrics, and answers a client's frame with its ACK.
func (h *Hub) forwardFrame(ch *Channel, conn *websocket.Conn, role string, self *mobilePeer, channelID string, frame inboundFrame, log *slog.Logger) forwardOutcome {
	direction := forwardDirection(role)
	data := frame.data

	ch.mu.Lock()
	peers, data, named := ch.selectPeersLocked(role, self, data, log)
	ch.mu.Unlock()

	// One read of the outer envelope serves both the mobile ACK and the
	// forward span. An ion frame is only parsed when spans are on.
	var env wireEnvelope
	envOK := false
	if role == "mobile" || h.otlp.tracing() {
		envOK = json.Unmarshal(data, &env) == nil
	}

	// A frame with a valid traceparent gets a span, and the span's id goes
	// onto the wire in the traceparent's span-id slot so the receiver
	// parents under relay.forward. Without spans the frame is untouched: a
	// span id nobody records would leave a hole in the trace.
	var parent traceContext
	spanID := ""
	if envOK && env.Traceparent != "" && h.otlp.tracing() {
		if tc, ok := parseTraceparent(env.Traceparent); ok {
			id, err := newSpanID()
			switch {
			case err != nil:
				log.Warn("span id generation failed; frame forwarded without a span",
					"tag", "relay.trace", "seq", env.Seq, "err", err)
			default:
				parent, spanID = tc, id
				if rewritten, ok := rewriteTraceparent(data, env.Traceparent, id); ok {
					data = rewritten
				} else {
					log.Warn("traceparent not found in the envelope bytes; forwarded unchanged",
						"tag", "relay.trace", "seq", env.Seq, "span_id", id)
				}
			}
		} else {
			log.Debug("invalid traceparent; no span recorded", "tag", "relay.trace", "seq", env.Seq)
		}
	}

	out := forwardOutcome{peers: len(peers), named: named}
	if len(peers) == 0 {
		if role == "mobile" && envOK && env.Seq > 0 {
			log.Debug("forward ack: no peer connected",
				"tag", "relay.forward_ack", "seq", env.Seq, "outcome", "peer-unavailable", "reason", "no_peer")
			sendControlPayload(conn, forwardAck{Type: "relay:peer-unavailable", Seq: env.Seq, Reason: "no_peer"}, h.WriteTimeout, log)
		}
		return out
	}

	writeStart := time.Now()
	var slowest time.Duration
	slowPeer := ""
	for _, peer := range peers {
		peerStart := time.Now()
		writeCtx, writeCancel := context.WithTimeout(context.Background(), h.WriteTimeout)
		err := peer.conn.Write(writeCtx, frame.msgType, data)
		writeCancel()
		if took := time.Since(peerStart); took > slowest || slowPeer == "" {
			slowest, slowPeer = took, peer.id
		}
		if err != nil {
			log.Warn("forward error", "tag", "relay.forward_error", "peer", peer.id, "err", err)
			if out.writeErr == nil {
				out.writeErr = err
			}
		}
	}
	end := time.Now()
	h.metrics.forwarded(direction, end.Sub(frame.recvAt))

	if spanID != "" {
		h.otlp.recordForward(forwardSpan{
			SpanID:        spanID,
			Parent:        parent,
			Start:         frame.readStart,
			End:           end,
			Direction:     direction,
			ChannelID:     channelID,
			Seq:           env.Seq,
			Bytes:         len(data),
			ReadTime:      frame.recvAt.Sub(frame.readStart),
			WriteTime:     end.Sub(writeStart),
			Peers:         len(peers),
			PeerWriteTime: slowest,
			SlowPeer:      slowPeer,
			WriteErr:      out.writeErr,
		})
	}

	if role == "mobile" && envOK && env.Seq > 0 {
		if out.writeErr == nil {
			log.Debug("forward ack sent", "tag", "relay.forward_ack", "seq", env.Seq, "outcome", "forwarded")
			sendControlPayload(conn, forwardAck{Type: "relay:forwarded", Seq: env.Seq}, h.WriteTimeout, log)
		} else {
			log.Warn("forward ack: peer write failed",
				"tag", "relay.forward_ack", "seq", env.Seq, "outcome", "peer-unavailable", "reason", "write_failed")
			sendControlPayload(conn, forwardAck{Type: "relay:peer-unavailable", Seq: env.Seq, Reason: "write_failed"}, h.WriteTimeout, log)
		}
	}
	return out
}

// rewriteTraceparent replaces the span id of the outer envelope's
// traceparent member with spanID, in a copy of data, and reports whether it
// found the member. current is the value the envelope parsed to, so the
// member is located by its key and that exact quoted value; the trace id,
// the flags, and every other byte of the frame are unchanged. A frame whose
// bytes do not carry the member in that form (JSON string escapes in the
// key, a duplicate key the decoder resolved differently) is returned as is.
func rewriteTraceparent(data []byte, current, spanID string) ([]byte, bool) {
	if len(spanID) != 16 {
		return data, false
	}
	key := []byte(`"traceparent"`)
	quoted := []byte(`"` + current + `"`)
	off := 0
	for off < len(data) {
		i := bytes.Index(data[off:], key)
		if i < 0 {
			return data, false
		}
		i += off
		off = i + len(key)
		j := skipJSONSpace(data, off)
		if j >= len(data) || data[j] != ':' {
			continue
		}
		j = skipJSONSpace(data, j+1)
		if !bytes.HasPrefix(data[j:], quoted) {
			continue
		}
		out := make([]byte, len(data))
		copy(out, data)
		// The value starts after the opening quote; the span id occupies
		// bytes 36..52 of a version-00 traceparent.
		copy(out[j+1+36:j+1+52], spanID)
		return out, true
	}
	return data, false
}

func skipJSONSpace(data []byte, i int) int {
	for i < len(data) {
		switch data[i] {
		case ' ', '\t', '\n', '\r':
			i++
		default:
			return i
		}
	}
	return i
}

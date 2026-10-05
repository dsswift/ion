package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"

	"github.com/coder/websocket"
)

// mobilePeer is one client on a channel's mobile side.
type mobilePeer struct {
	// id names the peer to a multi-client server. The relay mints it at
	// join; it means nothing outside this channel.
	id   string
	conn *websocket.Conn
	// ownerKey is the identity the peer joined with, for an OIDC join
	// validated against the relay's own issuers. Empty for a PSK join and
	// for a server-announced-trust join, which the channel's own server
	// already vouched for. See Hub.EvictForeignMobile.
	ownerKey string
}

// Control frames a multi-client server receives in place of
// relay:peer-reconnected and relay:peer-disconnected: each names the client.
const (
	controlPeerJoined = "relay:peer-joined"
	controlPeerLeft   = "relay:peer-left"
)

// peerControl is a control frame about, or addressed to, one mobile peer.
type peerControl struct {
	Type string `json:"type"`
	Peer string `json:"peer"`
}

// peerEnvelope reads the one outer field a multi-client server sets to say
// which client a frame is for. Empty means every client on the channel.
type peerEnvelope struct {
	Peer string `json:"peer"`
}

func newPeerID() string {
	b := make([]byte, 6)
	if _, err := rand.Read(b); err != nil {
		// crypto/rand does not fail on a supported platform; an id still
		// has to be unique within the channel, which a counter is not.
		panic("relay: no randomness for a peer id: " + err.Error())
	}
	return hex.EncodeToString(b)
}

// mobileLocked finds a mobile peer by id. The channel lock must be held.
func (ch *Channel) mobileLocked(id string) *mobilePeer {
	for _, p := range ch.mobiles {
		if p.id == id {
			return p
		}
	}
	return nil
}

// removeMobileLocked takes conn off the channel and reports whether it was
// still on it. A connection that was replaced is already gone.
func (ch *Channel) removeMobileLocked(conn *websocket.Conn) bool {
	for i, p := range ch.mobiles {
		if p.conn == conn {
			ch.mobiles = append(ch.mobiles[:i], ch.mobiles[i+1:]...)
			return true
		}
	}
	return false
}

// mobileConnsLocked is every mobile connection, oldest first.
func (ch *Channel) mobileConnsLocked() []*websocket.Conn {
	out := make([]*websocket.Conn, 0, len(ch.mobiles))
	for _, p := range ch.mobiles {
		out = append(out, p.conn)
	}
	return out
}

// closeMobilesLocked closes and removes every mobile peer but keep (nil
// closes them all): the one-client rule a server that is not multi-client
// relies on.
func (ch *Channel) closeMobilesLocked(keep *mobilePeer) {
	for _, p := range ch.mobiles {
		if p != keep {
			// A graceful close waits for the client's own close frame. Off
			// the channel lock, so a client that is slow to answer does not
			// hold up the one replacing it.
			go p.conn.Close(websocket.StatusGoingAway, "replaced") //nolint:errcheck // closing a replaced connection
		}
	}
	ch.mobiles = ch.mobiles[:0]
	if keep != nil {
		ch.mobiles = append(ch.mobiles, keep)
	}
}

// stampPeer writes the sending client's id into a frame's outer JSON object
// as its last member, so the stamp wins over any `peer` the client put there
// itself. The relay does not otherwise read or re-encode the frame. A frame
// that is not a JSON object is returned unchanged and false.
func stampPeer(data []byte, id string) ([]byte, bool) {
	trimmed := bytes.TrimSpace(data)
	if len(trimmed) < 2 || trimmed[0] != '{' || trimmed[len(trimmed)-1] != '}' {
		return data, false
	}
	body := trimmed[:len(trimmed)-1]
	out := make([]byte, 0, len(body)+len(id)+12)
	out = append(out, body...)
	if len(bytes.TrimSpace(body[1:])) > 0 {
		out = append(out, ',')
	}
	out = append(out, `"peer":"`...)
	out = append(out, id...)
	out = append(out, `"}`...)
	return out, true
}

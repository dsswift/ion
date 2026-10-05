package main

import (
	"context"
	"encoding/json"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
)

const testKey = "test-key-multi"

// dialMulti dials the channel as a multi-client server.
func dialMulti(t *testing.T, serverURL, channelID string) *websocket.Conn {
	t.Helper()
	url := "ws" + strings.TrimPrefix(serverURL, "http") + "/v1/channel/" + channelID + "?role=ion&multi=1"
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	conn, _, err := websocket.Dial(ctx, url, &websocket.DialOptions{
		HTTPHeader:      http.Header{"Authorization": []string{"Bearer " + testKey}},
		CompressionMode: websocket.CompressionContextTakeover,
	})
	if err != nil {
		t.Fatalf("dial failed: %v", err)
	}
	t.Cleanup(func() { conn.CloseNow() })
	return conn
}

func readFrame(t *testing.T, conn *websocket.Conn, label string) map[string]any {
	t.Helper()
	var out map[string]any
	if err := json.Unmarshal(readExpected(t, conn, label), &out); err != nil {
		t.Fatalf("%s: not JSON: %v", label, err)
	}
	return out
}

// expectSilence fails when conn receives anything within a short wait.
func expectSilence(t *testing.T, conn *websocket.Conn, label string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	if _, data, err := conn.Read(ctx); err == nil {
		t.Fatalf("%s: expected nothing, got %s", label, data)
	}
}

// joinedPeer reads the server's relay:peer-joined and returns the peer id.
func joinedPeer(t *testing.T, ion *websocket.Conn, label string) string {
	t.Helper()
	f := readFrame(t, ion, label)
	if f["type"] != controlPeerJoined || f["peer"] == "" {
		t.Fatalf("%s: expected relay:peer-joined with a peer, got %v", label, f)
	}
	return f["peer"].(string)
}

// A multi-client server keeps every client of its pairing: a second client
// joins beside the first, each client's frames arrive stamped with its id,
// and a server frame reaches only the client it names.
func TestMultiClientChannel(t *testing.T) {
	server, _ := startTestRelay(t, testKey)
	ion := dialMulti(t, server.URL, "multi-1")
	a := dialWS(t, server, "multi-1", "mobile", testKey)
	peerA := joinedPeer(t, ion, "join a")
	b := dialWS(t, server, "multi-1", "mobile", testKey)
	peerB := joinedPeer(t, ion, "join b")
	if peerA == peerB {
		t.Fatalf("two clients share the peer id %q", peerA)
	}

	// The first client is still on the channel: its frame arrives, stamped.
	ctx := context.Background()
	if err := a.Write(ctx, websocket.MessageText, []byte(`{"seq":1,"ciphertext":"from-a","peer":"forged"}`)); err != nil {
		t.Fatal(err)
	}
	got := readFrame(t, ion, "frame from a")
	if got["ciphertext"] != "from-a" || got["peer"] != peerA {
		t.Fatalf("frame from a = %v, want peer %s", got, peerA)
	}
	if ack := readFrame(t, a, "ack to a"); ack["type"] != "relay:forwarded" {
		t.Fatalf("ack to a = %v", ack)
	}
	if err := b.Write(ctx, websocket.MessageText, []byte(`{"seq":1,"ciphertext":"from-b"}`)); err != nil {
		t.Fatal(err)
	}
	if got := readFrame(t, ion, "frame from b"); got["peer"] != peerB {
		t.Fatalf("frame from b = %v, want peer %s", got, peerB)
	}
	readFrame(t, b, "ack to b")

	// A named frame reaches only its client: the other's next frame is the
	// broadcast that follows, which names no client and reaches them all.
	if err := ion.Write(ctx, websocket.MessageText, []byte(`{"seq":7,"ciphertext":"for-b","peer":"`+peerB+`"}`)); err != nil {
		t.Fatal(err)
	}
	if got := readFrame(t, b, "frame for b"); got["ciphertext"] != "for-b" {
		t.Fatalf("frame for b = %v", got)
	}
	if err := ion.Write(ctx, websocket.MessageText, []byte(`{"seq":8,"ciphertext":"for-all"}`)); err != nil {
		t.Fatal(err)
	}
	if got := readFrame(t, a, "broadcast to a"); got["ciphertext"] != "for-all" {
		t.Fatalf("a's next frame = %v, want the broadcast", got)
	}
	if got := readFrame(t, b, "broadcast to b"); got["ciphertext"] != "for-all" {
		t.Fatalf("b's next frame = %v, want the broadcast", got)
	}

	// A client leaving is named to the server, and the other stays. A frame
	// for the client that left goes nowhere.
	a.Close(websocket.StatusNormalClosure, "")
	if left := readFrame(t, ion, "a left"); left["type"] != controlPeerLeft || left["peer"] != peerA {
		t.Fatalf("leave notice = %v, want relay:peer-left for %s", left, peerA)
	}
	if err := ion.Write(ctx, websocket.MessageText, []byte(`{"seq":9,"ciphertext":"gone","peer":"`+peerA+`"}`)); err != nil {
		t.Fatal(err)
	}
	if err := ion.Write(ctx, websocket.MessageText, []byte(`{"seq":10,"ciphertext":"still-here","peer":"`+peerB+`"}`)); err != nil {
		t.Fatal(err)
	}
	if got := readFrame(t, b, "b after a left"); got["ciphertext"] != "still-here" {
		t.Fatalf("b's next frame = %v, want its own", got)
	}
}

// A multi-client server that joins after its clients is told who is there.
func TestMultiClientServerJoinsLate(t *testing.T) {
	server, hub := startTestRelay(t, testKey)
	hub.getOrCreateChannel("multi-2").multi = true
	a := dialWS(t, server, "multi-2", "mobile", testKey)
	b := dialWS(t, server, "multi-2", "mobile", testKey)
	ion := dialMulti(t, server.URL, "multi-2")
	first, second := joinedPeer(t, ion, "existing 1"), joinedPeer(t, ion, "existing 2")
	if first == second {
		t.Fatalf("both existing clients reported as %q", first)
	}
	for _, c := range []*websocket.Conn{a, b} {
		if f := readFrame(t, c, "server arrived"); f["type"] != "relay:peer-reconnected" {
			t.Fatalf("client notice = %v, want relay:peer-reconnected", f)
		}
	}
}

// A server that did not ask for multi-client keeps the one-client rule: the
// second client replaces the first, frames are not stamped, and the server
// hears the old control frames.
func TestSingleClientServerKeepsOneClient(t *testing.T) {
	server, hub := startTestRelay(t, testKey)
	ion := dialWS(t, server, "single-1", "ion", testKey)
	a := dialWS(t, server, "single-1", "mobile", testKey)
	if f := readFrame(t, ion, "join a"); f["type"] != "relay:peer-reconnected" {
		t.Fatalf("join notice = %v", f)
	}
	b := dialWS(t, server, "single-1", "mobile", testKey)
	if f := readFrame(t, ion, "join b"); f["type"] != "relay:peer-reconnected" {
		t.Fatalf("join notice = %v", f)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := a.Read(ctx); err == nil {
		t.Fatal("the first client was not closed when the second joined")
	}
	if err := b.Write(context.Background(), websocket.MessageText, []byte(`{"seq":1,"ciphertext":"x"}`)); err != nil {
		t.Fatal(err)
	}
	got := readFrame(t, ion, "frame from b")
	if _, stamped := got["peer"]; stamped {
		t.Fatalf("a single-client server got a stamped frame: %v", got)
	}
	// The replaced client's exit is not reported as the client leaving.
	expectSilence(t, ion, "server after the replaced client's exit")
	if _, mobile := hub.ChannelStatus("single-1"); !mobile {
		t.Fatal("the channel lost its client")
	}
}

// A single-client server that takes over a channel with several clients
// keeps only the newest.
func TestSingleClientServerPrunesClients(t *testing.T) {
	server, hub := startTestRelay(t, testKey)
	hub.getOrCreateChannel("prune-1").multi = true
	a := dialWS(t, server, "prune-1", "mobile", testKey)
	b := dialWS(t, server, "prune-1", "mobile", testKey)
	dialWS(t, server, "prune-1", "ion", testKey)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	if _, _, err := a.Read(ctx); err == nil {
		t.Fatal("the older client stayed on a single-client server's channel")
	}
	if f := readFrame(t, b, "server arrived"); f["type"] != "relay:peer-reconnected" {
		t.Fatalf("newest client notice = %v", f)
	}
}

func TestStampPeer(t *testing.T) {
	cases := []struct{ in, want string }{
		{`{"seq":1}`, `{"seq":1,"peer":"p1"}`},
		{`{}`, `{"peer":"p1"}`},
		{"  {\"a\":{\"b\":1}}\n", `{"a":{"b":1},"peer":"p1"}`},
	}
	for _, c := range cases {
		got, ok := stampPeer([]byte(c.in), "p1")
		if !ok || string(got) != c.want {
			t.Errorf("stampPeer(%q) = %q, %v; want %q", c.in, got, ok, c.want)
		}
		var decoded map[string]any
		if err := json.Unmarshal(got, &decoded); err != nil || decoded["peer"] != "p1" {
			t.Errorf("stamped %q does not decode with the peer: %v", got, err)
		}
	}
	if _, ok := stampPeer([]byte(`[1,2]`), "p1"); ok {
		t.Error("stamped a frame that is not an object")
	}
	// The stamp is the last member, so it wins over one the client wrote.
	got, _ := stampPeer([]byte(`{"peer":"forged"}`), "p1")
	var decoded map[string]any
	if err := json.Unmarshal(got, &decoded); err != nil || decoded["peer"] != "p1" {
		t.Errorf("a client's own peer survived the stamp: %s", got)
	}
}

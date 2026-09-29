package studioclient

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"

	"github.com/coder/websocket"

	"github.com/dsswift/ion/engine/internal/utils"
)

const logTag = "studioclient"

// PairTimeout bounds one pairing exchange.
const PairTimeout = 10 * time.Second

// PairingLink is a parsed `ion-studio://pair?...` link.
type PairingLink struct {
	Code  string
	URL   string
	Label string
	// Relay is set when the link names a relay pairing channel.
	Relay *PairingRelay
}

// PairingRelay is the one-time relay channel a link offers for pairing.
type PairingRelay struct {
	URL     string
	Channel string
	Key     string
}

var linkCode = regexp.MustCompile(`^[0-9a-f]{32}$`)

// ParsePairingLink reads a minted pairing link. Short discovery codes are for
// a desktop's Nearby flow and are refused here.
func ParsePairingLink(link string) (PairingLink, error) {
	u, err := url.Parse(strings.TrimSpace(link))
	if err != nil || u.Scheme != "ion-studio" || u.Host != "pair" {
		return PairingLink{}, errors.New("not an ion-studio://pair link")
	}
	q := u.Query()
	code := q.Get("code")
	if !linkCode.MatchString(code) {
		return PairingLink{}, errors.New("the link carries no 32-character pairing code")
	}
	base, err := url.Parse(q.Get("url"))
	if err != nil || (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return PairingLink{}, errors.New("the link names no http(s) server address")
	}
	out := PairingLink{Code: code, URL: strings.TrimSuffix(base.Scheme+"://"+base.Host+base.Path, "/"), Label: strings.TrimSpace(q.Get("env"))}
	relayURL, channel := strings.TrimSpace(q.Get("relay")), strings.TrimSpace(q.Get("channel"))
	if linkCode.MatchString(channel) && (strings.HasPrefix(relayURL, "wss://") || strings.HasPrefix(relayURL, "ws://")) {
		out.Relay = &PairingRelay{URL: relayURL, Channel: channel, Key: strings.TrimSpace(q.Get("relayKey"))}
	}
	return out, nil
}

// RelayAuth is how a client authenticates to one relay a server is reachable
// through, as the server advertised it at pairing and at every welcome.
type RelayAuth struct {
	Mode     string `json:"mode"` // psk | oidc | relay-oidc
	Key      string `json:"key,omitempty"`
	Issuer   string `json:"issuer,omitempty"`
	Audience string `json:"audience,omitempty"`
	Scope    string `json:"scope,omitempty"`
	ClientID string `json:"clientId,omitempty"`
}

// Relay is one relay and its auth.
type Relay struct {
	URL  string    `json:"url"`
	Auth RelayAuth `json:"auth"`
}

// Pairing is what a completed pairing leaves the client with.
type Pairing struct {
	ClientID     string   `json:"clientId"`
	SharedSecret []byte   `json:"sharedSecret"`
	Scopes       []string `json:"scopes"`
	Relays       []Relay  `json:"relays"`
}

// PairRequest is the exchange both doors carry.
type PairRequest struct {
	Type          string `json:"type,omitempty"`
	Code          string `json:"code"`
	PeerPublicKey string `json:"peerPublicKey"`
	Label         string `json:"label"`
	Kind          string `json:"kind"`
	DeviceID      string `json:"deviceId,omitempty"`
}

type pairResponse struct {
	Type         string   `json:"type"`
	OK           *bool    `json:"ok"`
	ClientID     string   `json:"clientId"`
	OurPublicKey string   `json:"ourPublicKey"`
	Scopes       []string `json:"scopes"`
	Relays       []Relay  `json:"relays"`
	Error        string   `json:"error"`
}

// NewPairRequest makes a key pair and the request that presents it.
func NewPairRequest(code, label, deviceID string) (PairRequest, KeyPair, error) {
	kp, err := GenerateKeyPair()
	if err != nil {
		return PairRequest{}, KeyPair{}, err
	}
	return PairRequest{Code: code, PeerPublicKey: base64.StdEncoding.EncodeToString(kp.Public), Label: label, Kind: "desktop", DeviceID: deviceID}, kp, nil
}

func (r pairResponse) complete(kp KeyPair) (Pairing, error) {
	if r.Error != "" {
		return Pairing{}, fmt.Errorf("the server refused the pairing: %s", r.Error)
	}
	if r.ClientID == "" || r.OurPublicKey == "" {
		return Pairing{}, errors.New("the server answered the pairing with an unexpected payload")
	}
	peer, err := base64.StdEncoding.DecodeString(r.OurPublicKey)
	if err != nil {
		return Pairing{}, fmt.Errorf("server public key: %w", err)
	}
	secret, err := kp.SharedSecret(peer)
	if err != nil {
		return Pairing{}, err
	}
	return Pairing{ClientID: r.ClientID, SharedSecret: secret, Scopes: r.Scopes, Relays: r.Relays}, nil
}

// PairOverHTTP runs the exchange against `POST <base>/auth/pair`.
func PairOverHTTP(ctx context.Context, base string, req PairRequest, kp KeyPair) (Pairing, error) {
	ctx, cancel := context.WithTimeout(ctx, PairTimeout)
	defer cancel()
	req.Type = ""
	body, err := json.Marshal(req)
	if err != nil {
		return Pairing{}, err
	}
	httpReq, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(base, "/")+"/auth/pair", bytes.NewReader(body))
	if err != nil {
		return Pairing{}, err
	}
	httpReq.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(httpReq)
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "pairing over http: unreachable", map[string]any{"url": base, "error": err.Error()})
		return Pairing{}, fmt.Errorf("could not reach %s: %w", base, err)
	}
	defer resp.Body.Close() //nolint:errcheck // response body close after full read
	data, err := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if err != nil {
		return Pairing{}, fmt.Errorf("read pair response: %w", err)
	}
	var r pairResponse
	if err := json.Unmarshal(data, &r); err != nil {
		return Pairing{}, fmt.Errorf("pair response is not JSON (HTTP %d)", resp.StatusCode)
	}
	if resp.StatusCode != http.StatusOK && r.Error == "" {
		r.Error = fmt.Sprintf("HTTP %d", resp.StatusCode)
	}
	p, err := r.complete(kp)
	logPairOutcome("http", base, p, err)
	return p, err
}

// PairOverRelay runs the exchange on a link's one-time relay pairing channel.
func PairOverRelay(ctx context.Context, relay PairingRelay, bearer string, req PairRequest, kp KeyPair) (Pairing, error) {
	ctx, cancel := context.WithTimeout(ctx, PairTimeout)
	defer cancel()
	conn, err := dialRelay(ctx, relay.URL, "pairing:"+relay.Channel, bearer)
	if err != nil {
		return Pairing{}, err
	}
	defer conn.CloseNow() //nolint:errcheck // one-shot pairing socket
	req.Type = "pair_request"
	out, err := json.Marshal(req)
	if err != nil {
		return Pairing{}, err
	}
	if err := conn.Write(ctx, websocket.MessageText, out); err != nil {
		return Pairing{}, fmt.Errorf("send pair_request: %w", err)
	}
	for {
		_, data, err := conn.Read(ctx)
		if err != nil {
			return Pairing{}, fmt.Errorf("the relay %s did not answer the pairing: %w", relay.URL, err)
		}
		if isRelayControl(string(data)) {
			continue
		}
		var r pairResponse
		if json.Unmarshal(data, &r) != nil || r.Type != "pair_response" || r.OK == nil {
			continue
		}
		if !*r.OK && r.Error == "" {
			r.Error = "refused"
		}
		p, err := r.complete(kp)
		logPairOutcome("relay", relay.URL, p, err)
		return p, err
	}
}

func logPairOutcome(door, where string, p Pairing, err error) {
	if err != nil {
		utils.LogWithFields(utils.LevelWarn, logTag, "pairing failed", map[string]any{"door": door, "where": where, "error": err.Error()})
		return
	}
	utils.LogWithFields(utils.LevelInfo, logTag, "pairing completed", map[string]any{"door": door, "where": where, "client_id": p.ClientID, "relay_count": len(p.Relays), "scopes": p.Scopes})
}

// relayJoinURL is the relay's channel endpoint for the joining side.
func relayJoinURL(relayURL, channel string) string {
	base := strings.TrimSuffix(relayURL, "/")
	base = strings.Replace(strings.Replace(base, "https://", "wss://", 1), "http://", "ws://", 1)
	return base + "/v1/channel/" + channel + "?role=mobile"
}

func dialRelay(ctx context.Context, relayURL, channel, bearer string) (*websocket.Conn, error) {
	conn, resp, err := websocket.Dial(ctx, relayJoinURL(relayURL, channel), &websocket.DialOptions{
		HTTPHeader: http.Header{"Authorization": []string{"Bearer " + bearer}},
	})
	if err != nil {
		status := 0
		if resp != nil {
			status = resp.StatusCode
		}
		utils.LogWithFields(utils.LevelWarn, logTag, "relay join failed", map[string]any{"relay_url": relayURL, "http_status": status, "error": err.Error()})
		if status == http.StatusUnauthorized || status == http.StatusForbidden {
			return nil, fmt.Errorf("the relay %s refused the join (HTTP %d)", relayURL, status)
		}
		return nil, fmt.Errorf("join relay %s: %w", relayURL, err)
	}
	conn.SetReadLimit(16 << 20)
	return conn, nil
}

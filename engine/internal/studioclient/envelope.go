package studioclient

import (
	"encoding/json"
	"errors"
	"strings"
)

// RelayEnvelopeVersion is the sealed envelope format both ends of a relay
// channel must share (packages/shared/src/studio-wire/relay-envelope.ts).
const RelayEnvelopeVersion = 1

type envelope struct {
	V          int    `json:"v"`
	Nonce      string `json:"nonce"`
	Ciphertext string `json:"ciphertext"`
	Bin        bool   `json:"bin,omitempty"`
}

// SealFrame seals one text Studio wire frame for the relay.
func SealFrame(frame, secret []byte) (string, error) {
	nonce, ct, err := encrypt(frame, secret)
	if err != nil {
		return "", err
	}
	out, err := json.Marshal(envelope{V: RelayEnvelopeVersion, Nonce: nonce, Ciphertext: ct})
	return string(out), err
}

// errNotEnvelope marks relay text that is not a sealed frame.
var errNotEnvelope = errors.New("not a relay envelope")

// OpenFrame opens a sealed envelope. isBinary reports a binary wire frame.
func OpenFrame(raw string, secret []byte) (frame []byte, isBinary bool, err error) {
	var e envelope
	if json.Unmarshal([]byte(raw), &e) != nil || e.V != RelayEnvelopeVersion || e.Nonce == "" || e.Ciphertext == "" {
		return nil, false, errNotEnvelope
	}
	frame, err = decrypt(e.Nonce, e.Ciphertext, secret)
	if err != nil {
		return nil, false, err
	}
	return frame, e.Bin, nil
}

// isRelayControl reports the relay's own plaintext `relay:*` frames, which a
// client skips.
func isRelayControl(raw string) bool {
	var probe struct {
		Type string `json:"type"`
	}
	return json.Unmarshal([]byte(raw), &probe) == nil && strings.HasPrefix(probe.Type, "relay:")
}

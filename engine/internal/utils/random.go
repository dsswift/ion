// Random helpers for engine-internal observability identifiers.
//
// RandomID generates a short hex string suitable for correlating
// observability events (webhook request id, schedule fire id). Not
// cryptographically meaningful — just a stable handle a log reader can
// grep for. crypto/rand provides the bytes so collisions across
// concurrent processes are effectively impossible.

package utils

import (
	"crypto/rand"
	"encoding/hex"
	"sync/atomic"
	"time"
)

// degradedIDCounter guarantees uniqueness between two degraded IDs minted
// inside the same nanosecond tick. Only ever touched on the crypto/rand
// failure path.
var degradedIDCounter atomic.Uint64

// degradedIDBytes fills b with a non-random but non-zero, locally-unique
// byte pattern derived from the wall clock and a process-lifetime counter.
//
// This is the crypto/rand failure fallback for the ID helpers below. It is
// deliberately NOT a security substitute for crypto/rand — it is unguessable
// by nobody and must never back a token, nonce, or key. Its only job is to
// keep observability identifiers structurally valid and mutually distinct
// when the entropy source is unavailable, because the alternative (an
// all-zero ID) is a value the W3C trace-context spec requires consumers to
// reject outright, which silently destroys correlation at exactly the moment
// something has already gone wrong on the machine.
func degradedIDBytes(b []byte) {
	seed := uint64(time.Now().UnixNano()) ^ (degradedIDCounter.Add(1) << 32)
	for i := range b {
		// splitmix64-style avalanche so successive seeds do not produce
		// near-identical byte strings.
		seed ^= seed >> 30
		seed *= 0xbf58476d1ce4e5b9
		seed ^= seed >> 27
		b[i] = byte(seed >> uint(8*(i%8)))
	}
	// Guarantee the all-zero case is impossible even if the arithmetic above
	// ever degenerates: the spec-invalid value is the one thing we must not
	// emit.
	b[0] |= 0x01
}

// RandomID returns a 16-character hex string (8 random bytes). Used
// for engine_*_received → engine_*_responded correlation ids and
// similar internal handles where collision-resistance matters but
// cryptographic strength does not.
//
// On the (extremely unlikely) failure to read from crypto/rand, falls back to
// a clock-and-counter derived value (never all-zero, still 16 lowercase hex
// chars) so the identifier stays usable as a correlation handle. An all-zero
// ID would collapse every concurrent request onto one indistinguishable value
// — the opposite of what a correlation handle is for. The fallback is logged
// at Warn so the operator sees the entropy failure.
func RandomID() string {
	var b [8]byte
	if _, err := rand.Read(b[:]); err != nil {
		Warn("utils", "RandomID: crypto/rand read failed, using degraded clock-derived id: "+err.Error())
		degradedIDBytes(b[:])
	}
	return hex.EncodeToString(b[:])
}

// NewTraceID returns a 32-character lowercase hex string (16 random bytes):
// a W3C trace-context compliant trace-id, minted once per run so every log
// line and telemetry event emitted for that run correlates. See
// docs/observability/log-schema.md for the correlation-ID vocabulary and
// which identifier to use at which granularity.
//
// The returned value is safe to place directly in a `traceparent` header
// (`00-<traceID>-<spanID>-01`) by a consumer exporting spans to an OTLP
// backend.
//
// On the (extremely unlikely) failure to read from crypto/rand, falls back to
// a clock-and-counter derived value rather than an all-zero string. W3C
// trace-context §3.2.2.3 declares an all-zero trace-id *invalid* and requires
// consumers to ignore the whole traceparent, so the zero fallback this
// replaced broke correlation precisely when it claimed to preserve it. The
// fallback is logged at Warn.
func NewTraceID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		Warn("utils", "NewTraceID: crypto/rand read failed, using degraded clock-derived trace id: "+err.Error())
		degradedIDBytes(b[:])
	}
	return hex.EncodeToString(b[:])
}

package stream

import (
	"bytes"
	"fmt"
	"io"

	"github.com/hamba/avro/v2/ocf"
)

// CaptureSchema is the Avro record Event Hubs Capture writes, one per
// event. The sample's capture writer produces the same shape so a reader
// built against real Capture output reads the local files unchanged. Only
// EnqueuedTimeUtc's rendering differs: Capture writes a locale-style
// timestamp, the sample writes RFC 3339.
const CaptureSchema = `{
  "type": "record", "name": "EventData", "namespace": "Microsoft.ServiceBus.Messaging",
  "fields": [
    {"name": "SequenceNumber", "type": "long"},
    {"name": "Offset", "type": "string"},
    {"name": "EnqueuedTimeUtc", "type": "string"},
    {"name": "SystemProperties", "type": {"type": "map", "values": ["long", "double", "string", "bytes"]}},
    {"name": "Properties", "type": {"type": "map", "values": ["long", "double", "string", "bytes"]}},
    {"name": "Body", "type": ["null", "bytes"]}
  ]
}`

// CaptureRecord is one Avro record in a capture file.
type CaptureRecord struct {
	SequenceNumber   int64          `avro:"SequenceNumber"`
	Offset           string         `avro:"Offset"`
	EnqueuedTimeUtc  string         `avro:"EnqueuedTimeUtc"`
	SystemProperties map[string]any `avro:"SystemProperties"`
	Properties       map[string]any `avro:"Properties"`
	Body             []byte         `avro:"Body"`
}

// EncodeCapture writes records as one Avro object container file.
func EncodeCapture(records []CaptureRecord) ([]byte, error) {
	var buf bytes.Buffer
	enc, err := ocf.NewEncoder(CaptureSchema, &buf, ocf.WithCodec(ocf.Deflate))
	if err != nil {
		return nil, fmt.Errorf("avro encoder: %w", err)
	}
	for _, r := range records {
		if r.SystemProperties == nil {
			r.SystemProperties = map[string]any{}
		}
		if r.Properties == nil {
			r.Properties = map[string]any{}
		}
		if err := enc.Encode(r); err != nil {
			return nil, fmt.Errorf("avro encode: %w", err)
		}
	}
	if err := enc.Close(); err != nil {
		return nil, fmt.Errorf("avro close: %w", err)
	}
	return buf.Bytes(), nil
}

// DecodeCapture reads every record of one capture file.
func DecodeCapture(r io.Reader) ([]CaptureRecord, error) {
	dec, err := ocf.NewDecoder(r)
	if err != nil {
		return nil, fmt.Errorf("avro decoder: %w", err)
	}
	var out []CaptureRecord
	for dec.HasNext() {
		var rec CaptureRecord
		if err := dec.Decode(&rec); err != nil {
			return nil, fmt.Errorf("avro decode: %w", err)
		}
		out = append(out, rec)
	}
	return out, dec.Error()
}

package telemetry

import (
	"context"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"sync"
	"testing"
	"time"

	"github.com/dsswift/ion/engine/internal/types"
	collectortrace "go.opentelemetry.io/proto/otlp/collector/trace/v1"
	"google.golang.org/grpc"
	"google.golang.org/grpc/metadata"
	"google.golang.org/protobuf/proto"
)

func TestNewOtelBridgeDefaultsToHTTPProtobuf(t *testing.T) {
	bridge := NewOtelBridge(OtelConfig{Endpoint: "http://localhost:4318"})
	t.Cleanup(func() {
		if err := bridge.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	if got, want := bridge.config.Protocol, otlpProtocolHTTPProtobuf; got != want {
		t.Errorf("Protocol = %q, want %q", got, want)
	}
	if got, want := bridge.config.ServiceName, "ion-engine"; got != want {
		t.Errorf("ServiceName = %q, want %q", got, want)
	}
}

func TestOtelBridgeHTTPProtobufExportsConfiguredHeadersAndResource(t *testing.T) {
	requests := make(chan *collectortrace.ExportTraceServiceRequest, 1)
	var header http.Header
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		header = request.Header.Clone()
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		var export collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(payload, &export); err != nil {
			t.Errorf("unmarshal OTLP protobuf: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requests <- &export
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	bridge := NewOtelBridge(OtelConfig{
		Endpoint:           server.URL,
		Protocol:           otlpProtocolHTTPProtobuf,
		Headers:            map[string]string{"X-OTLP-Test": "http"},
		ServiceName:        "telemetry-test",
		ResourceAttributes: map[string]string{"deployment.environment": "test"},
		BatchSize:          1,
	})
	t.Cleanup(func() {
		if err := bridge.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	bridge.RecordEvent(Event{
		Name:    "telemetry.http",
		Ts:      time.Now().UTC().Format(time.RFC3339Nano),
		TraceID: "4bf92f3577b34da6a3ce929d0e0e4736",
	})
	request := waitForOTLPRequest(t, requests)

	if got, want := header.Get("X-OTLP-Test"), "http"; got != want {
		t.Errorf("HTTP header = %q, want %q", got, want)
	}
	if got, want := header.Get("Content-Type"), "application/x-protobuf"; got != want {
		t.Errorf("Content-Type = %q, want %q", got, want)
	}
	assertOTLPRequest(t, request, "telemetry.http", map[string]string{
		"service.name":           "telemetry-test",
		"deployment.environment": "test",
	})
	if got, want := request.ResourceSpans[0].ScopeSpans[0].Spans[0].TraceId, "\x4b\xf9\x2f\x35\x77\xb3\x4d\xa6\xa3\xce\x92\x9d\x0e\x0e\x47\x36"; string(got) != want {
		t.Errorf("span trace ID = %x, want %x", got, want)
	}
}

func TestOtelBridgeGRPCExportsConfiguredHeadersAndResource(t *testing.T) {
	server := &testTraceService{requests: make(chan *collectortrace.ExportTraceServiceRequest, 1)}
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatalf("listen: %v", err)
	}
	grpcServer := grpc.NewServer()
	collectortrace.RegisterTraceServiceServer(grpcServer, server)
	go func() {
		if serveErr := grpcServer.Serve(listener); serveErr != nil {
			t.Errorf("serve gRPC: %v", serveErr)
		}
	}()
	t.Cleanup(func() {
		grpcServer.Stop()
	})

	bridge := NewOtelBridge(OtelConfig{
		Endpoint:           listener.Addr().String(),
		Protocol:           otlpProtocolGRPC,
		Headers:            map[string]string{"x-otlp-test": "grpc"},
		ServiceName:        "telemetry-test",
		ResourceAttributes: map[string]string{"deployment.environment": "test"},
		BatchSize:          1,
	})
	t.Cleanup(func() {
		if err := bridge.Close(); err != nil {
			t.Errorf("Close: %v", err)
		}
	})

	bridge.RecordEvent(Event{Name: "telemetry.grpc", Ts: time.Now().UTC().Format(time.RFC3339Nano)})
	request := waitForOTLPRequest(t, server.requests)

	if got, want := server.header.Get("x-otlp-test"), "grpc"; len(got) != 1 || got[0] != want {
		t.Errorf("gRPC header = %q, want [%q]", got, want)
	}
	assertOTLPRequest(t, request, "telemetry.grpc", map[string]string{
		"service.name":           "telemetry-test",
		"deployment.environment": "test",
	})
}

func TestNewCollectorConfiguresOtelBridgeProtocolAndResource(t *testing.T) {
	requests := make(chan *collectortrace.ExportTraceServiceRequest, 1)
	server := httptest.NewServer(http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		payload, err := io.ReadAll(request.Body)
		if err != nil {
			t.Errorf("read request: %v", err)
			writer.WriteHeader(http.StatusInternalServerError)
			return
		}
		var export collectortrace.ExportTraceServiceRequest
		if err := proto.Unmarshal(payload, &export); err != nil {
			t.Errorf("unmarshal OTLP protobuf: %v", err)
			writer.WriteHeader(http.StatusBadRequest)
			return
		}
		requests <- &export
		writer.WriteHeader(http.StatusOK)
	}))
	defer server.Close()

	collector := NewCollector(types.TelemetryConfig{
		Enabled: true,
		Targets: []string{"otel"},
		Otel: &types.OtelConfig{
			Enabled:            true,
			Endpoint:           server.URL,
			Protocol:           otlpProtocolHTTPProtobuf,
			ServiceName:        "collector-test",
			ResourceAttributes: map[string]string{"test.resource": "configured"},
		},
	})
	t.Cleanup(collector.Close)
	collector.Event("telemetry.configured", nil, nil)
	if err := collector.Flush(); err != nil {
		t.Fatalf("Flush: %v", err)
	}
	assertOTLPRequest(t, waitForOTLPRequest(t, requests), "telemetry.configured", map[string]string{
		"service.name":  "collector-test",
		"test.resource": "configured",
	})
}

func waitForOTLPRequest(t *testing.T, requests <-chan *collectortrace.ExportTraceServiceRequest) *collectortrace.ExportTraceServiceRequest {
	t.Helper()
	select {
	case request := <-requests:
		return request
	case <-time.After(time.Second):
		t.Fatal("did not receive OTLP export")
		return nil
	}
}

func assertOTLPRequest(t *testing.T, request *collectortrace.ExportTraceServiceRequest, spanName string, resourceAttributes map[string]string) {
	t.Helper()
	if len(request.ResourceSpans) != 1 {
		t.Fatalf("resource spans = %d, want 1", len(request.ResourceSpans))
	}
	actualResource := make(map[string]string)
	for _, attribute := range request.ResourceSpans[0].Resource.Attributes {
		actualResource[attribute.Key] = attribute.Value.GetStringValue()
	}
	for key, want := range resourceAttributes {
		if got := actualResource[key]; got != want {
			t.Errorf("resource attribute %q = %q, want %q", key, got, want)
		}
	}
	if len(request.ResourceSpans[0].ScopeSpans) != 1 || len(request.ResourceSpans[0].ScopeSpans[0].Spans) != 1 {
		t.Fatal("want one scope span containing one span")
	}
	if got := request.ResourceSpans[0].ScopeSpans[0].Spans[0].Name; got != spanName {
		t.Errorf("span name = %q, want %q", got, spanName)
	}
}

type testTraceService struct {
	collectortrace.UnimplementedTraceServiceServer
	requests chan *collectortrace.ExportTraceServiceRequest
	header   metadata.MD
	mu       sync.Mutex
}

func (service *testTraceService) Export(ctx context.Context, request *collectortrace.ExportTraceServiceRequest) (*collectortrace.ExportTraceServiceResponse, error) {
	service.mu.Lock()
	service.header, _ = metadata.FromIncomingContext(ctx)
	service.mu.Unlock()
	service.requests <- request
	return &collectortrace.ExportTraceServiceResponse{}, nil
}

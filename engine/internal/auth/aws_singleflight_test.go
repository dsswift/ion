package auth

import (
	"context"
	"sync"
	"testing"
	"time"
)

type blockingAWSProvider struct {
	started chan struct{}
	release chan struct{}
	once    sync.Once
	calls   int
	mu      sync.Mutex
}

func (p *blockingAWSProvider) Kind() string { return "test" }
func (p *blockingAWSProvider) Retrieve(context.Context) (*AWSCredentials, error) {
	p.mu.Lock()
	p.calls++
	p.mu.Unlock()
	p.once.Do(func() { close(p.started) })
	<-p.release
	return &AWSCredentials{AccessKeyID: "A", SecretAccessKey: "B", ExpiresAt: time.Now().Add(time.Hour)}, nil
}

func TestCachedAWSProviderSingleflightAndWaitCancellation(t *testing.T) {
	inner := &blockingAWSProvider{started: make(chan struct{}), release: make(chan struct{})}
	cached := NewCachedAWSProvider(inner, time.Minute)
	firstDone := make(chan error, 1)
	go func() {
		_, err := cached.Retrieve(context.Background())
		firstDone <- err
	}()
	<-inner.started

	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := cached.Retrieve(ctx); err != context.Canceled {
		t.Fatalf("waiting caller error = %v", err)
	}
	close(inner.release)
	if err := <-firstDone; err != nil {
		t.Fatal(err)
	}
	if _, err := cached.Retrieve(context.Background()); err != nil {
		t.Fatal(err)
	}
	inner.mu.Lock()
	calls := inner.calls
	inner.mu.Unlock()
	if calls != 1 {
		t.Fatalf("inner calls = %d, want 1", calls)
	}
}

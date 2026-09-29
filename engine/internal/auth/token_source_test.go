package auth

import (
	"context"
	"fmt"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

func TestMachineTokenCache_CacheHit(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	calls := 0
	acquire := func(_ context.Context) (string, time.Time, error) {
		calls++
		return "tok-1", time.Now().Add(10 * time.Minute), nil
	}

	tok, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err != nil || tok != "tok-1" {
		t.Fatalf("first acquire: tok=%q err=%v", tok, err)
	}
	tok2, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err != nil || tok2 != "tok-1" {
		t.Fatalf("second acquire: tok=%q err=%v", tok2, err)
	}
	if calls != 1 {
		t.Fatalf("expected 1 acquire call, got %d", calls)
	}
}

func TestMachineTokenCache_ExpiredTokenRefreshed(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	round := 0
	acquire := func(_ context.Context) (string, time.Time, error) {
		round++
		return fmt.Sprintf("tok-%d", round), time.Now().Add(30 * time.Second), nil
	}

	tok, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err != nil || tok != "tok-1" {
		t.Fatalf("first: tok=%q err=%v", tok, err)
	}
	// Token expires within threshold (30s < 60s threshold) so next call re-acquires.
	tok2, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err != nil || tok2 != "tok-2" {
		t.Fatalf("refresh: tok=%q err=%v", tok2, err)
	}
}

func TestMachineTokenCache_Singleflight(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	var acquireCount int32
	entered := make(chan struct{})
	release := make(chan struct{})
	acquire := func(_ context.Context) (string, time.Time, error) {
		if atomic.AddInt32(&acquireCount, 1) == 1 {
			close(entered)
		}
		<-release
		return "coalesced", time.Now().Add(10 * time.Minute), nil
	}

	var wg sync.WaitGroup
	results := make([]string, 5)
	for i := range results {
		wg.Add(1)
		go func(idx int) {
			defer wg.Done()
			tok, _ := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
			results[idx] = tok
		}(i)
	}
	<-entered
	close(release)
	wg.Wait()

	if n := atomic.LoadInt32(&acquireCount); n != 1 {
		t.Fatalf("expected 1 acquire call, got %d (singleflight broken)", n)
	}
	for i, r := range results {
		if r != "coalesced" {
			t.Errorf("goroutine %d got %q, want coalesced", i, r)
		}
	}
}

func TestMachineTokenCache_ContextCancel(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	entered := make(chan struct{})
	block := make(chan struct{})
	acquire := func(_ context.Context) (string, time.Time, error) {
		close(entered)
		<-block
		return "late", time.Now().Add(10 * time.Minute), nil
	}

	// Start one acquire that blocks.
	go func() {
		cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire) //nolint:errcheck
	}()
	<-entered

	// Second caller cancels while waiting for the flight.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := cache.getOrAcquire(ctx, "", "p", "s", "scope", "aud", acquire)
	if err != context.Canceled {
		t.Fatalf("expected context.Canceled, got %v", err)
	}
	close(block)
}

func TestMachineTokenCache_DifferentKeys(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	calls := 0
	acquire := func(_ context.Context) (string, time.Time, error) {
		calls++
		return fmt.Sprintf("tok-%d", calls), time.Now().Add(10 * time.Minute), nil
	}

	tok1, _ := cache.getOrAcquire(context.Background(), "", "p", "s", "scope-a", "aud-1", acquire)
	tok2, _ := cache.getOrAcquire(context.Background(), "", "p", "s", "scope-b", "aud-2", acquire)
	if tok1 == tok2 {
		t.Fatalf("different keys returned same token")
	}
	if calls != 2 {
		t.Fatalf("expected 2 acquire calls, got %d", calls)
	}
}

func TestMachineTokenCache_ErrorNotCached(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	round := 0
	acquire := func(_ context.Context) (string, time.Time, error) {
		round++
		if round == 1 {
			return "", time.Time{}, fmt.Errorf("transient")
		}
		return "recovered", time.Now().Add(10 * time.Minute), nil
	}

	_, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err == nil {
		t.Fatal("expected error on first call")
	}
	tok, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err != nil || tok != "recovered" {
		t.Fatalf("second call: tok=%q err=%v", tok, err)
	}
}

func TestMachineTokenCache_EmptyTokenIsError(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	acquire := func(_ context.Context) (string, time.Time, error) {
		return "", time.Now().Add(10 * time.Minute), nil
	}

	_, err := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if err == nil {
		t.Fatal("expected error for empty token")
	}
}

// TestTokenCacheSubjectIsolation pins R-04: the cache keys by subject, so two
// principals requesting the same scope+audience coalesce independently and
// never see each other's token. An empty subject reproduces today's key
// exactly, which is what keeps every pre-existing (subject-less) consumer
// unchanged.
func TestTokenCacheSubjectIsolation(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	calls := map[string]int{}
	var mu sync.Mutex
	acquire := func(subject string) func(context.Context) (string, time.Time, error) {
		return func(_ context.Context) (string, time.Time, error) {
			mu.Lock()
			calls[subject]++
			mu.Unlock()
			return "tok-" + subject, time.Now().Add(10 * time.Minute), nil
		}
	}

	aliceTok, err := cache.getOrAcquire(context.Background(), "alice", "p", "s", "scope", "aud", acquire("alice"))
	if err != nil || aliceTok != "tok-alice" {
		t.Fatalf("alice: tok=%q err=%v", aliceTok, err)
	}
	bobTok, err := cache.getOrAcquire(context.Background(), "bob", "p", "s", "scope", "aud", acquire("bob"))
	if err != nil || bobTok != "tok-bob" {
		t.Fatalf("bob: tok=%q err=%v", bobTok, err)
	}

	// Repeat requests hit the cache, not a fresh acquire, and never cross.
	aliceTok2, _ := cache.getOrAcquire(context.Background(), "alice", "p", "s", "scope", "aud", acquire("alice"))
	if aliceTok2 != "tok-alice" {
		t.Fatalf("alice cache hit returned %q, expected isolation from bob", aliceTok2)
	}
	if calls["alice"] != 1 || calls["bob"] != 1 {
		t.Fatalf("expected exactly one acquire per subject, got %v", calls)
	}
}

// TestMachineTokenCache_EmptySubjectUnchanged pins that a subject-less caller
// (every existing consumer before this program) reproduces today's cache key
// exactly, so it is unaffected by the subject dimension.
func TestMachineTokenCache_EmptySubjectUnchanged(t *testing.T) {
	cache := newMachineTokenCache(60 * time.Second)
	calls := 0
	acquire := func(_ context.Context) (string, time.Time, error) {
		calls++
		return "unchanged-tok", time.Now().Add(10 * time.Minute), nil
	}

	tok1, _ := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	tok2, _ := cache.getOrAcquire(context.Background(), "", "p", "s", "scope", "aud", acquire)
	if tok1 != tok2 || calls != 1 {
		t.Fatalf("expected a single subject-less cache entry reused, got tok1=%q tok2=%q calls=%d", tok1, tok2, calls)
	}
}

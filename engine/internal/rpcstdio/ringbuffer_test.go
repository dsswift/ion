package rpcstdio

import (
	"sync"
	"testing"
)

func TestRingBuffer_EvictsOldest(t *testing.T) {
	rb := NewRingBuffer(3)
	rb.Write("line1")
	rb.Write("line2")
	rb.Write("line3")
	rb.Write("line4") // evicts line1

	lines := rb.Lines()
	if len(lines) != 3 {
		t.Fatalf("expected 3 lines, got %d", len(lines))
	}
	if lines[0] != "line2" {
		t.Errorf("expected first line 'line2', got %q", lines[0])
	}
	if lines[2] != "line4" {
		t.Errorf("expected last line 'line4', got %q", lines[2])
	}
}

func TestRingBuffer_Empty(t *testing.T) {
	rb := NewRingBuffer(5)
	if lines := rb.Lines(); len(lines) != 0 {
		t.Fatalf("expected 0 lines, got %d", len(lines))
	}
}

func TestRingBuffer_ConcurrentWrites_NoRace(t *testing.T) {
	rb := NewRingBuffer(50)
	var wg sync.WaitGroup
	wg.Add(20)
	for i := 0; i < 20; i++ {
		go func() {
			defer wg.Done()
			for j := 0; j < 100; j++ {
				rb.Write("x")
			}
			_ = rb.Lines()
		}()
	}
	wg.Wait()
	if got := len(rb.Lines()); got != 50 {
		t.Fatalf("expected buffer capped at 50, got %d", got)
	}
}

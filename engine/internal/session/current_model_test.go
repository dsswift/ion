package session

import (
	"fmt"
	"sync"
	"testing"
)

func TestSessionAccessorCurrentModelConcurrentUpdate(t *testing.T) {
	s := &engineSession{}
	accessor := &sessionAccessor{s: s}

	var wg sync.WaitGroup
	wg.Add(2)
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			s.setCurrentModel(fmt.Sprintf("model-%d", i))
		}
	}()
	go func() {
		defer wg.Done()
		for i := 0; i < 1000; i++ {
			_ = accessor.CurrentModel()
		}
	}()
	wg.Wait()

	if got := accessor.CurrentModel(); got == "" {
		t.Fatal("current model remained empty after updates")
	}
}

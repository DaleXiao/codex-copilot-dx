package guard

import (
	"context"
	"sync"
	"sync/atomic"
	"testing"
)

func TestWindowCacheIdentityAndExactScores(t *testing.T) {
	c := &windowCache{}
	calls := 0
	expected := &windowResult{scores: []tokenScore{{3, 1, 0.812345678912345}}}
	compute := func() *windowResult { calls++; return expected }
	a, kind := c.read(context.Background(), []int{0, 4, 8, 2}, compute)
	if a != expected || kind != "evaluated" {
		t.Fatal("initial result")
	}
	b, kind := c.read(context.Background(), []int{0, 4, 8, 2}, compute)
	if b != a || kind != "hit" || b.scores[0].prob != expected.scores[0].prob {
		t.Fatal("cache changed scores")
	}
	c.read(context.Background(), []int{0, 4, 9, 2}, compute)
	c.read(context.Background(), []int{0, 4, 8, 2, 2}, compute)
	if calls != 3 {
		t.Fatal("different token IDs or lengths reused a result")
	}
	if c.pending([]int{0, 4, 8, 2}) || !c.pending([]int{0, 99, 2}) {
		t.Fatal("planning must distinguish fully cached and unevaluated windows")
	}
}

func TestWindowCacheSharesAndKeepsCanceledWork(t *testing.T) {
	c := &windowCache{}
	started, release := make(chan struct{}), make(chan struct{})
	var calls atomic.Int32
	compute := func() *windowResult { calls.Add(1); close(started); <-release; return &windowResult{} }
	done := make(chan struct{})
	go func() { c.read(context.Background(), []int{0, 7, 2}, compute); close(done) }()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	result, kind := c.read(ctx, []int{0, 7, 2}, compute)
	if result != nil || kind != "cancelled" {
		t.Fatal("canceled waiter")
	}
	var wg sync.WaitGroup
	for range 16 {
		wg.Go(func() { c.read(context.Background(), []int{0, 7, 2}, compute) })
	}
	close(release)
	<-done
	wg.Wait()
	if calls.Load() != 1 {
		t.Fatal("shared window computed twice")
	}
	if _, kind := c.read(context.Background(), []int{0, 7, 2}, compute); kind != "hit" {
		t.Fatal("completed window lost")
	}
}

func TestWindowCacheBudgetsAndFailureRecovery(t *testing.T) {
	c := &windowCache{}
	for i := 0; i < 6000; i++ {
		c.read(context.Background(), []int{0, i, 2}, func() *windowResult { return &windowResult{} })
	}
	entries, bytes := c.usage()
	if entries > windowCacheEntries || bytes > windowCacheBytes {
		t.Fatal("entry budget")
	}
	heavy := &windowCache{}
	for i := 0; i < 700; i++ {
		heavy.read(context.Background(), []int{0, i, 2}, func() *windowResult { return &windowResult{scores: make([]tokenScore, 510)} })
	}
	_, bytes = heavy.usage()
	if bytes > windowCacheBytes {
		t.Fatal("byte budget")
	}
	failed := &windowCache{}
	func() {
		defer func() { recover() }()
		failed.read(context.Background(), []int{0, 4, 2}, func() *windowResult { panic("synthetic model failure") })
	}()
	result, kind := failed.read(context.Background(), []int{0, 4, 2}, func() *windowResult { return &windowResult{} })
	if result == nil || kind != "evaluated" {
		t.Fatal("failed read poisoned the cache")
	}
}

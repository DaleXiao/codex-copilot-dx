package guard

import (
	"container/list"
	"context"
	"crypto/sha256"
	"encoding/binary"
	"sync"
)

const windowCacheBytes = 4 << 20
const windowCacheEntries = 5000

// O scores are not consumed by decode. Sparse non-O tags retain exact
// probabilities without keeping dense logits, token IDs or original text.
type tokenScore struct {
	at    uint16
	label uint8
	prob  float64
}
type windowResult struct{ scores []tokenScore }
type cachedWindow struct {
	key    [32]byte
	result *windowResult
	bytes  int
}
type windowRead struct {
	done   chan struct{}
	result *windowResult
}
type windowCache struct {
	mu      sync.Mutex
	entries map[[32]byte]*list.Element
	reading map[[32]byte]*windowRead
	order   list.List
	bytes   int
}
type WindowWork struct {
	Evaluated int `json:"evaluated"`
	Hits      int `json:"hits"`
	Shared    int `json:"shared"`
	Total     int `json:"total"`
}

func windowKey(ids []int) [32]byte {
	b := make([]byte, 4+4*len(ids))
	binary.LittleEndian.PutUint32(b, uint32(len(ids)))
	for i, id := range ids {
		binary.LittleEndian.PutUint32(b[4+i*4:], uint32(id))
	}
	return sha256.Sum256(b)
}

// Planning does not claim work or hold CPU admission. In-flight windows are
// still pending; only a fully published cached result needs no model work.
func (c *windowCache) pending(ids []int) bool {
	key := windowKey(ids)
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.entries[key] == nil
}

// An identical-window waiter holds no CPU admission slot. The owner finishes
// its current computation even if its caller left and publishes before waking.
func (c *windowCache) read(ctx context.Context, ids []int, compute func() *windowResult) (*windowResult, string) {
	if ctx.Err() != nil {
		return nil, "cancelled"
	}
	key := windowKey(ids)
	c.mu.Lock()
	if e := c.entries[key]; e != nil {
		c.order.MoveToBack(e)
		result := e.Value.(cachedWindow).result
		c.mu.Unlock()
		return result, "hit"
	}
	if r := c.reading[key]; r != nil {
		c.mu.Unlock()
		select {
		case <-r.done:
			return r.result, "shared"
		case <-ctx.Done():
			return nil, "cancelled"
		}
	}
	if c.reading == nil {
		c.reading = make(map[[32]byte]*windowRead)
	}
	r := &windowRead{done: make(chan struct{})}
	c.reading[key] = r
	c.mu.Unlock()
	published := false
	defer func() {
		if !published {
			c.mu.Lock()
			delete(c.reading, key)
			close(r.done)
			c.mu.Unlock()
		}
	}()
	result := compute()
	if result == nil {
		return nil, "failed"
	}
	c.mu.Lock()
	r.result = result
	delete(c.reading, key)
	cost := 256 + cap(result.scores)*16
	if cost <= windowCacheBytes {
		if c.entries == nil {
			c.entries = make(map[[32]byte]*list.Element)
		}
		c.entries[key] = c.order.PushBack(cachedWindow{key, result, cost})
		c.bytes += cost
		for c.bytes > windowCacheBytes || c.order.Len() > windowCacheEntries {
			e := c.order.Front()
			old := e.Value.(cachedWindow)
			delete(c.entries, old.key)
			c.bytes -= old.bytes
			c.order.Remove(e)
		}
	}
	close(r.done)
	published = true
	c.mu.Unlock()
	return result, "evaluated"
}

func (c *windowCache) usage() (entries, bytes int) {
	c.mu.Lock()
	defer c.mu.Unlock()
	return c.order.Len(), c.bytes
}

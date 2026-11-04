package main

import (
	"bufio"
	"context"
	"encoding/json"
	"os"
	"sync"
	"time"

	"ccdx.local/privacy/guard"
)

type request struct {
	ID           int      `json:"id"`
	Texts        []string `json:"texts"`
	CancelID     int      `json:"cancel_id"`
	CacheWindows *bool    `json:"cache_windows"`
	PlanWindows  bool     `json:"plan_windows"`
}
type span struct {
	Start int     `json:"start"`
	End   int     `json:"end"`
	Label string  `json:"label"`
	Score float64 `json:"score"`
}

func main() {
	if len(os.Args) != 2 {
		os.Exit(2)
	}
	m, err := guard.Load(os.Args[1])
	if err != nil {
		os.Exit(3)
	}
	m.Find("Local privacy detection is ready for English and 中文 text.")
	out := json.NewEncoder(os.Stdout)
	via, device, _ := m.Backend()
	initialEntries, initialBytes := m.WindowCacheUsage()
	out.Encode(map[string]any{"ready": true, "backend": via, "device": device, "window_cache": true, "window_plan": true, "cancel_between_windows": true, "cpu_short_batch": true, "window_cache_entries": initialEntries, "window_cache_bytes": initialBytes})
	var outputMu, activeMu sync.Mutex
	active := map[int]context.CancelFunc{}
	var jobs sync.WaitGroup
	sem := make(chan struct{}, guard.Cores())
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 65536), 16*1024*1024)
	for in.Scan() {
		var r request
		if json.Unmarshal(in.Bytes(), &r) != nil {
			os.Exit(4)
		}
		if r.CancelID > 0 {
			activeMu.Lock()
			cancel := active[r.CancelID]
			activeMu.Unlock()
			if cancel != nil {
				cancel()
			}
			continue
		}
		if r.ID < 1 || len(r.Texts) > 8192 {
			os.Exit(4)
		}
		ctx, cancel := context.WithCancel(context.Background())
		activeMu.Lock()
		if len(active) >= 8 || active[r.ID] != nil {
			activeMu.Unlock()
			cancel()
			os.Exit(4)
		}
		active[r.ID] = cancel
		activeMu.Unlock()
		jobs.Add(1)
		go func(r request) {
			var found [][]span
			work := guard.WindowWork{}
			complete := false
			failure := ""
			start := time.Now()
			defer func() {
				if recover() != nil {
					failure = "engine_invalid"
					complete = false
				}
				cancel()
				activeMu.Lock()
				delete(active, r.ID)
				activeMu.Unlock()
				entries, bytes := m.WindowCacheUsage()
				reply := map[string]any{"id": r.ID, "found": found, "elapsed_ms": time.Since(start).Milliseconds(), "complete": complete,
					"window_work": work, "window_cache_entries": entries, "window_cache_bytes": bytes}
				if failure != "" {
					reply["error"] = failure
				}
				outputMu.Lock()
				out.Encode(reply)
				outputMu.Unlock()
				jobs.Done()
			}()
			select {
			case sem <- struct{}{}:
			case <-ctx.Done():
				failure = "cancelled"
				return
			}
			defer func() { <-sem }()
			reuse := r.CacheWindows == nil || *r.CacheWindows
			var plan func(int, int, int)
			if r.PlanWindows {
				plan = func(index, pending, total int) {
					outputMu.Lock()
					out.Encode(map[string]any{"id": r.ID, "phase": "plan", "text_index": index, "pending_windows": pending, "total_windows": total})
					outputMu.Unlock()
				}
			}
			var results [][]guard.Span
			results, work, complete = m.FindTextsPlanned(ctx, r.Texts, reuse, plan)
			if !complete {
				if ctx.Err() != nil {
					failure = "cancelled"
				} else {
					failure = "engine_invalid"
				}
				return
			}
			found = make([][]span, len(r.Texts))
			for i, spans := range results {
				for _, s := range spans {
					if s.Score >= guard.MinScore {
						found[i] = append(found[i], span{s.Start, s.End, s.Label, s.Score})
					}
				}
			}
		}(r)
	}
	jobs.Wait()
	if in.Err() != nil {
		os.Exit(5)
	}
}

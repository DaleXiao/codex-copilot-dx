package main

import (
	"bufio"
	"encoding/json"
	"os"
	"sync"
	"time"

	"ccdx.local/privacy/guard"
)

type request struct {
	ID    int      `json:"id"`
	Texts []string `json:"texts"`
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
	out.Encode(map[string]any{"ready": true, "backend": via, "device": device})
	var mu sync.Mutex
	var jobs sync.WaitGroup
	sem := make(chan struct{}, guard.Cores())
	in := bufio.NewScanner(os.Stdin)
	in.Buffer(make([]byte, 65536), 16*1024*1024)
	for in.Scan() {
		var r request
		if json.Unmarshal(in.Bytes(), &r) != nil || r.ID < 1 || len(r.Texts) > 8192 {
			os.Exit(4)
		}
		sem <- struct{}{}
		jobs.Add(1)
		go func(r request) {
			defer jobs.Done()
			defer func() { <-sem }()
			start := time.Now()
			found := make([][]span, len(r.Texts))
			for i, text := range r.Texts {
				for _, s := range m.Find(text) {
					if s.Score >= guard.MinScore {
						found[i] = append(found[i], span{s.Start, s.End, s.Label, s.Score})
					}
				}
			}
			mu.Lock()
			out.Encode(map[string]any{"id": r.ID, "found": found, "elapsed_ms": time.Since(start).Milliseconds()})
			mu.Unlock()
		}(r)
	}
	jobs.Wait()
	if in.Err() != nil {
		os.Exit(5)
	}
}

package guard

import (
	"context"
	"runtime"
	"sync"
	"sync/atomic"
)

const shortBatchBytes = 16 << 10

type shortText struct {
	index  int
	tokens []token
	ids    []int
}

// FindTextsPlanned batches independent CPU sequences, not concatenated text.
// Each sequence retains its positions, attention and quantization range. The
// group holds at most one model window's tokens and the existing text budget.
func (m *Model) FindTextsPlanned(ctx context.Context, texts []string, reuse bool, onPlan func(int, int, int)) ([][]Span, WindowWork, bool) {
	if len(texts) == 1 {
		var plan func(int, int)
		if onPlan != nil {
			plan = func(pending, total int) { onPlan(0, pending, total) }
		}
		found, work, complete := m.FindPlanned(ctx, texts[0], reuse, plan)
		return [][]Span{found}, work, complete
	}
	out, works, done := make([][]Span, len(texts)), make([]WindowWork, len(texts)), make([]bool, len(texts))
	var group []shortText
	bytes, tokens := 0, 0
	plan := func(index int) func(int, int) {
		if onPlan == nil {
			return nil
		}
		return func(pending, total int) { onPlan(index, pending, total) }
	}
	flush := func() bool {
		if len(group) == 0 {
			return true
		}
		fresh := len(group)
		if reuse {
			keys := map[[32]byte]bool{}
			for _, entry := range group {
				if m.windows.fresh(entry.ids) {
					keys[windowKey(entry.ids)] = true
				}
			}
			fresh = len(keys)
		}
		batched := len(group) > 1 && fresh > 1
		read := func(entry shortText, cores int) {
			out[entry.index], works[entry.index], done[entry.index] = m.findTokensPlanned(ctx, entry.tokens, reuse, plan(entry.index), cores)
		}
		if batched {
			var next atomic.Int32
			var wg sync.WaitGroup
			budget := Cores()
			workers := min(budget, fresh)
			for worker := range workers {
				cores := budget / workers
				if worker < budget%workers {
					cores++
				}
				wg.Go(func() {
					for at := int(next.Add(1)) - 1; at < len(group) && ctx.Err() == nil; at = int(next.Add(1)) - 1 {
						read(group[at], cores)
					}
				})
			}
			wg.Wait()
			evaluated := 0
			for _, entry := range group {
				evaluated += works[entry.index].Evaluated
			}
			if evaluated > 0 {
				works[group[0].index].CPUBatchGroups = 1
				works[group[0].index].CPUBatchWindows = evaluated
			}
		} else {
			for _, entry := range group {
				read(entry, 0)
			}
		}
		complete := true
		for _, entry := range group {
			complete = complete && done[entry.index]
		}
		group = nil
		bytes, tokens = 0, 0
		return complete
	}
	for index, text := range texts {
		if ctx.Err() != nil {
			break
		}
		if len(text) > shortBatchBytes {
			if !flush() {
				break
			}
			out[index], works[index], done[index] = m.FindPlanned(ctx, text, reuse, plan(index))
			if !done[index] {
				break
			}
			continue
		}
		toks := m.tok.encode(text)
		if len(toks) == 0 {
			done[index] = true
			continue
		}
		n := len(toks) + 2
		cpu := n <= maxPos && (m.ml == nil || !coremlWindow(runtime.GOARCH, m.ml.Device, n))
		if !cpu {
			if !flush() {
				break
			}
			out[index], works[index], done[index] = m.findTokensPlanned(ctx, toks, reuse, plan(index), 0)
			if !done[index] {
				break
			}
			continue
		}
		if tokens+n > maxPos || bytes+len(text) > shortBatchBytes {
			if !flush() {
				break
			}
		}
		ids := make([]int, 0, n)
		ids = append(ids, 0)
		for _, token := range toks {
			ids = append(ids, token.id)
		}
		ids = append(ids, 2)
		group = append(group, shortText{index, toks, ids})
		tokens += n
		bytes += len(text)
	}
	flush()
	work, complete := WindowWork{}, true
	for index, one := range works {
		work.Evaluated += one.Evaluated
		work.Hits += one.Hits
		work.Shared += one.Shared
		work.Total += one.Total
		work.CPUBatchGroups += one.CPUBatchGroups
		work.CPUBatchWindows += one.CPUBatchWindows
		complete = complete && done[index]
	}
	return out, work, complete
}

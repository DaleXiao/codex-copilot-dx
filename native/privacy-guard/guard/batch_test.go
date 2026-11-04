package guard

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
)

func cpuBatchModel(t *testing.T) *Model {
	t.Helper()
	dir := os.Getenv("CCDX_TEST_PRIVACY_MODEL")
	if dir == "" {
		t.Skip("verified model files are supplied by native integration checks")
	}
	tok, err := loadTokenizer(filepath.Join(dir, "tokenizer.json"))
	if err != nil {
		t.Fatal(err)
	}
	net, err := loadNet(filepath.Join(dir, "model_int8.onnx"))
	if err != nil {
		t.Fatal(err)
	}
	return &Model{tok: tok, net: net}
}

func individualFinds(t *testing.T, m *Model, texts []string) [][]Span {
	t.Helper()
	out := make([][]Span, len(texts))
	for index, text := range texts {
		var complete bool
		out[index], _, complete = m.FindPlanned(context.Background(), text, false, nil)
		if !complete {
			t.Fatal("reference sequence did not complete")
		}
	}
	return out
}

func batchFields(count int) []string {
	out := []string{"", " ", "Email" + ":", strings.Join([]string{"reader", "example.org"}, "@"), "Pass" + "word:", strings.Join([]string{"Cedar", "Quartz", "27!"}, ""), "中文字段", "😀 value", "data", "id"}
	for index := 0; index < count; index++ {
		out = append(out, fmt.Sprintf("sample field %d", index))
	}
	return out
}

func TestCPUShortBatchPreservesIndependentSequencesAndByteOffsets(t *testing.T) {
	m := cpuBatchModel(t)
	texts := append(batchFields(80), strings.Repeat("ordinary English 与中文 text\n", 180))
	want := individualFinds(t, m, texts)
	got, work, complete := m.FindTextsPlanned(context.Background(), texts, false, nil)
	if !complete || !reflect.DeepEqual(got, want) {
		t.Fatal("batch changed sequence findings, scores or byte offsets")
	}
	if work.CPUBatchGroups == 0 || work.CPUBatchWindows < 2 {
		t.Fatal("short sequences did not use bounded CPU groups")
	}
}

func TestCPUShortBatchReusesDuplicatesAndRetainsSingleAppendPath(t *testing.T) {
	m := cpuBatchModel(t)
	texts := append(batchFields(24), "sample field 0", "中文字段")
	want := individualFinds(t, m, texts)
	got, first, complete := m.FindTextsPlanned(context.Background(), texts, true, nil)
	if !complete || !reflect.DeepEqual(got, want) {
		t.Fatal("cold batch findings changed")
	}
	got, hot, complete := m.FindTextsPlanned(context.Background(), texts, true, nil)
	if !complete || !reflect.DeepEqual(got, want) || hot.Evaluated != 0 || hot.CPUBatchGroups != 0 {
		t.Fatal("cached batch repeated model work")
	}
	if first.Evaluated >= first.Total {
		t.Fatal("duplicate windows were not reused")
	}
	texts = append(texts, "a distinct additional item")
	got, appendWork, complete := m.FindTextsPlanned(context.Background(), texts, true, nil)
	if !complete || !reflect.DeepEqual(got, individualFinds(t, m, texts)) || appendWork.Evaluated != 1 || appendWork.CPUBatchGroups != 0 {
		t.Fatal("a single uncached append did not retain its original execution path")
	}
}

func TestConcurrentCPUShortBatchesSharePhysicalWindowWork(t *testing.T) {
	m := cpuBatchModel(t)
	texts := batchFields(32)
	want := individualFinds(t, m, texts)
	keys := map[[32]byte]bool{}
	for _, text := range texts {
		tokens := m.tok.encode(text)
		if len(tokens) == 0 {
			continue
		}
		ids := []int{0}
		for _, token := range tokens {
			ids = append(ids, token.id)
		}
		ids = append(ids, 2)
		keys[windowKey(ids)] = true
	}
	outputs := make([][][]Span, 2)
	works := make([]WindowWork, 2)
	completed := make([]bool, 2)
	start := make(chan struct{})
	var wg sync.WaitGroup
	for index := range outputs {
		wg.Go(func() {
			<-start
			outputs[index], works[index], completed[index] = m.FindTextsPlanned(context.Background(), texts, true, nil)
		})
	}
	close(start)
	wg.Wait()
	for index := range outputs {
		if !completed[index] || !reflect.DeepEqual(outputs[index], want) {
			t.Fatal("concurrent batch result changed")
		}
	}
	if works[0].Evaluated+works[1].Evaluated != len(keys) {
		t.Fatal("concurrent readers duplicated physical inference")
	}
}

func TestShortBatchCancelledBeforeSubmissionDoesNoWork(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, work, complete := (&Model{}).FindTextsPlanned(ctx, []string{"unread input"}, true, nil)
	if complete || work.Evaluated != 0 || work.CPUBatchGroups != 0 {
		t.Fatal("a cancelled batch began model work")
	}
}

func TestSingleNativeTextRetainsOriginalResultsAndWindowPlan(t *testing.T) {
	m := cpuBatchModel(t)
	for _, text := range []string{"single field", "", "中文内容", strings.Repeat("independent long text\n", 100)} {
		want, before, complete := m.FindPlanned(context.Background(), text, false, nil)
		if !complete {
			t.Fatal("reference text failed")
		}
		got, after, complete := m.FindTextsPlanned(context.Background(), []string{text}, false, func(index, pending, total int) {
			if index != 0 || pending > total {
				t.Fatal("single-text plan changed its index or window bound")
			}
		})
		if !complete || !reflect.DeepEqual(got, [][]Span{want}) || before != after || after.CPUBatchGroups != 0 {
			t.Fatal("single-text request did not retain its prior results and work")
		}
	}
}

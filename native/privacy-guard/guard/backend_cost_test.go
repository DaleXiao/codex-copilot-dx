package guard

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"testing"
	"time"
)

// Opt-in hardware comparison only. Ordinary unit tests never load weights.
func TestBackendCostComparison(t *testing.T) {
	dir := os.Getenv("CCDX_BACKEND_MODEL_DIR")
	if dir == "" {
		t.Skip("isolated model directory not supplied")
	}
	m, err := Load(dir)
	if err != nil {
		t.Fatal(err)
	}
	ml := m.ml
	if ml == nil {
		t.Fatal("CoreML comparison backend unavailable")
	}
	defer func() { m.ml = ml }()
	texts := []string{"The password is my-private-passphrase. Please keep it private."}
	for i := 0; i < 16; i++ {
		texts = append(texts, fmt.Sprintf("Tool %d reads a file and returns its contents without changing user settings.", i))
	}
	for _, backend := range []string{"current-policy", "Go"} {
		m.ml = ml
		if backend == "Go" {
			m.ml = nil
		}
		m.Find("Local synthetic warmup for English and 中文 text.")
		for _, group := range []struct {
			name  string
			texts []string
		}{{"short-fields", texts}, {"tokens-64", []string{strings.Repeat("ordinary ", 64)}},
			{"tokens-128", []string{strings.Repeat("ordinary ", 128)}}, {"tokens-256", []string{strings.Repeat("ordinary ", 256)}},
			{"code-6KiB", []string{strings.Repeat("const options = { timeout: 5000, retries: 2 };\n", 128)}}} {
			start := time.Now()
			spans, secrets := 0, 0
			for _, text := range group.texts {
				for _, span := range m.Find(text) {
					if span.Score >= MinScore {
						spans++
						if span.Label == "common_secret" {
							secrets++
						}
					}
				}
			}
			via, device, _ := m.Backend()
			row, _ := json.Marshal(map[string]any{"backend": backend, "primary_backend": via, "device": device, "case": group.name,
				"elapsed_ms": time.Since(start).Milliseconds(), "first_tokens": len(m.tok.encode(group.texts[0])) + 2, "texts": len(group.texts), "spans": spans, "secret_spans": secrets})
			fmt.Println("BACKEND_COST", string(row))
		}
	}
}

package guard

import "testing"

func TestNormalizeByteWidthsStayWithinInput(t *testing.T) {
	tk := &tokenizer{}
	for _, text := range []string{"\xff", "\xc3", "hello \xff", "\xed\xa0\x80", "\xf0\x9f", "中文😀", "\uFFFD"} {
		for _, part := range tk.normalize(text, 0) {
			if part.s < 0 || part.e > len(text) || part.s >= part.e {
				t.Fatalf("normalization returned out-of-bounds offset %d:%d over %d bytes", part.s, part.e, len(text))
			}
		}
		for _, part := range tk.encode(text) {
			if part.start < 0 || part.end > len(text) || part.start >= part.end {
				t.Fatalf("encoding returned out-of-bounds offset %d:%d over %d bytes", part.start, part.end, len(text))
			}
		}
	}
}

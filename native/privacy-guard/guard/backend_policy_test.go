package guard

import "testing"

func TestCoreMLWindowPolicyPreservesUnmeasuredDevices(t *testing.T) {
	for _, c := range []struct {
		arch, device string
		tokens       int
		want         bool
	}{
		{"amd64", "CPU", 16, false},
		{"amd64", "CPU", 127, false},
		{"amd64", "CPU", 128, true},
		{"amd64", "CPU", 512, true},
		{"amd64", "GPU", 16, true},
		{"amd64", "", 16, true},
		{"arm64", "CPU", 16, true},
		{"arm64", "Neural Engine", 16, true},
		{"arm64", "GPU", 16, true},
		{"arm64", "Neural Engine", 15, false},
	} {
		if got := coremlWindow(c.arch, c.device, c.tokens); got != c.want {
			t.Errorf("%s/%s/%d: got %v, want %v", c.arch, c.device, c.tokens, got, c.want)
		}
	}
}

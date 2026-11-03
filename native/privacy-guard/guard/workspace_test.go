package guard

import "testing"

func TestReusedMatmulMatchesIntegerReference(t *testing.T) {
	m := qmat{k: 4, n: 5, w: []int8{1, 2, 3, 4, -1, 0, 1, 2, 2, 2, 2, 2, -4, 3, -2, 1, 1, -1, 1, -1},
		scale: []float32{.1, .2, .3, .4, .5}, zp: []int32{0, 1, -1, 0, 1}, sum: []int32{10, 2, 8, -2, 0}}
	out := make([]float32, 10)
	for _, x := range [][]float32{{-1, 0, 1, 2, 3, -2, .5, 1}, {1, 1, 1, 1, -.5, .25, 2, 0}} {
		for i := range out {
			out[i] = 999
		}
		q, scale, zero := quant(x)
		got := m.matmulInto(x, 2, 3, out)
		for row := 0; row < 2; row++ {
			for col := 0; col < 5; col++ {
				var sum int32
				for i := 0; i < 4; i++ {
					sum += (int32(q[row*4+i]) - zero) * (int32(m.w[col*4+i]) - m.zp[col])
				}
				want := float32(sum) * (scale * m.scale[col])
				if got[row*5+col] != want {
					t.Fatalf("reused output differs from integer reference at %d,%d", row, col)
				}
			}
		}
	}
}

func TestReusedAttentionOverwritesEveryHeadAndRow(t *testing.T) {
	const n = 3
	qkv := make([]float32, n*3*hidden)
	ctx := make([]float32, n*hidden)
	for round := 0; round < 2; round++ {
		for i := range ctx {
			ctx[i] = 999
		}
		for row := 0; row < n; row++ {
			for col := 0; col < hidden; col++ {
				qkv[row*3*hidden+2*hidden+col] = float32(row + col%4 + round)
			}
		}
		attention(qkv, n, 3, ctx)
		for row := 0; row < n; row++ {
			for col := 0; col < hidden; col++ {
				if ctx[row*hidden+col] != float32(1+col%4+round) {
					t.Fatal("uniform attention did not overwrite a reused head/row")
				}
			}
		}
	}
}

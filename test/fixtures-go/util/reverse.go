package util

// Reverse は同一パッケージの別ファイル（strings.go）の ToUpper を呼ぶ
func Reverse(s string) string {
	upper := ToUpper(s)
	out := []rune(upper)
	for i, j := 0, len(out)-1; i < j; i, j = i+1, j-1 {
		out[i], out[j] = out[j], out[i]
	}
	return string(out)
}

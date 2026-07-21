package util

import "strings"

// ToUpper は公開関数（先頭大文字）。trim は同一ファイル内の非公開関数
func ToUpper(s string) string {
	return strings.ToUpper(trim(s))
}

func trim(s string) string {
	return strings.TrimSpace(s)
}

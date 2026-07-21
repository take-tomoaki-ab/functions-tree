package main

import (
	"fmt"

	stringsutil "example.com/app/util"
)

func main() {
	msg := buildMessage("hello")
	fmt.Println(msg)
}

func buildMessage(s string) string {
	srv := NewServer()
	srv.Start()
	srv.log("built")
	upper := stringsutil.ToUpper(s)
	each([]string{upper}, func(v string) {
		record(v)
	})
	return upper
}

func each(items []string, fn func(string)) {
	for _, it := range items {
		fn(it)
	}
}

func record(s string) {
	_ = s
}

package main

import "testing"

func TestBuildMessage(t *testing.T) {
	if buildMessage("x") == "" {
		t.Fatal("empty")
	}
}

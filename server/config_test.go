package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestLoadLocalEnv(t *testing.T) {
	first := filepath.Join(t.TempDir(), ".env")
	fallback := filepath.Join(t.TempDir(), ".env")
	t.Setenv("NANOSCOPE_TEST_EXISTING", "exported")
	const key = "NANOSCOPE_TEST_FROM_FILE"
	t.Setenv(key, "")
	os.Unsetenv(key)
	if err := os.WriteFile(first, []byte("NANOSCOPE_TEST_EXISTING=file\n"+key+"='value with # spaces'\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(fallback, []byte(key+"=fallback\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadLocalEnv(first+".missing", first, fallback); err != nil {
		t.Fatal(err)
	}
	if got := os.Getenv("NANOSCOPE_TEST_EXISTING"); got != "exported" {
		t.Fatalf("environment overridden: %q", got)
	}
	if got := os.Getenv(key); got != "value with # spaces" {
		t.Fatalf("unexpected file value: %q", got)
	}
}

func TestLoadLocalEnvMissingAndInvalid(t *testing.T) {
	path := filepath.Join(t.TempDir(), ".env")
	if err := loadLocalEnv(path); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("KEY=\"private-value\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := loadLocalEnv(path); err == nil {
		t.Fatal("invalid env file accepted")
	} else if strings.Contains(err.Error(), "private-value") {
		t.Fatal("error exposed file contents")
	}
}

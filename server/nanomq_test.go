package main

import "testing"

// Verbatim /api/v4/prometheus body from NanoMQ 0.21.9-10.
const promSample = `# TYPE nanomq_connections_count gauge
# HELP nanomq_connections_count
nanomq_connections_count 15
# TYPE nanomq_connections_max gauge
# HELP nanomq_connections_max
nanomq_connections_max 15
# TYPE nanomq_subscribers_count gauge
# HELP nanomq_subscribers_count
nanomq_subscribers_count 12
# TYPE nanomq_messages_received counter
# HELP nanomq_messages_received
nanomq_messages_received 4542
# TYPE nanomq_messages_sent counter
# HELP nanomq_messages_sent
nanomq_messages_sent 10066
# TYPE nanomq_messages_dropped counter
# HELP nanomq_messages_dropped
nanomq_messages_dropped 12
# TYPE nanomq_memory_usage gauge
# HELP nanomq_memory_usage (b)
nanomq_memory_usage 2859008
# TYPE nanomq_cpu_usage gauge
# HELP nanomq_cpu_usage (%)
nanomq_cpu_usage 0.00
`

func TestParsePrometheus(t *testing.T) {
	got := parsePrometheus(promSample)
	want := map[string]float64{
		"nanomq_connections_count": 15,
		"nanomq_connections_max":   15,
		"nanomq_subscribers_count": 12,
		"nanomq_messages_received": 4542,
		"nanomq_messages_sent":     10066,
		"nanomq_messages_dropped":  12,
		"nanomq_memory_usage":      2859008,
		"nanomq_cpu_usage":         0,
	}
	if len(got) != len(want) {
		t.Fatalf("parsed %d metrics, want %d: %v", len(got), len(want), got)
	}
	for k, v := range want {
		if got[k] != v {
			t.Errorf("%s = %v, want %v", k, got[k], v)
		}
	}
	// a dropped counter of 0 must survive as a real 0, not vanish
	if _, ok := parsePrometheus("nanomq_messages_dropped 0\n")["nanomq_messages_dropped"]; !ok {
		t.Error("zero-valued metric was dropped")
	}
}

func TestParsePrometheusJunk(t *testing.T) {
	for _, in := range []string{"", "# TYPE only\n", "no_value\n", "bad_metric abc\n", "\n\n  \n"} {
		if got := parsePrometheus(in); len(got) != 0 {
			t.Errorf("parsePrometheus(%q) = %v, want empty", in, got)
		}
	}
}

func TestParseUptime(t *testing.T) {
	tests := []struct{ in, want string }{
		{"15 Hours, 4 minutes, 19 seconds", "0d 15:04"},
		{"2 days, 3 Hours, 7 minutes", "2d 03:07"},
		{"49 Hours, 0 minutes, 0 seconds", "2d 01:00"},
		// NanoMQ 0.21.9-10 reports this frozen constant (~672 years) on every poll
		{"5891960 Hours, 2 minutes, 0 seconds", ""},
		{"", "0d 00:00"},
	}
	for _, tc := range tests {
		if got := parseUptime(tc.in); got != tc.want {
			t.Errorf("parseUptime(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}

func TestParseHostMetrics(t *testing.T) {
	f := func(v float64) *float64 { return &v }
	i := func(v int64) *int64 { return &v }

	tests := []struct {
		name string
		in   any
		cpu  *float64
		mem  *int64
	}{
		// verbatim /metrics payloads from NanoMQ 0.21.9-10
		{"idle", map[string]any{"metrics": []any{}, "cpuinfo": "0.01%", "memory": "5893948"}, f(0.01), i(5893948)},
		{"busy", map[string]any{"cpuinfo": "25.00%", "memory": "5893948"}, f(25), i(5893948)},
		{"zero cpu is a real reading", map[string]any{"cpuinfo": "0.00%", "memory": "5893948"}, f(0), i(5893948)},
		// a build that reported memory as a number rather than a string
		{"numeric memory", map[string]any{"cpuinfo": "9.52%", "memory": float64(5893948)}, f(9.52), i(5893948)},
		{"empty object", map[string]any{}, nil, nil},
		{"empty strings", map[string]any{"cpuinfo": "", "memory": ""}, nil, nil},
		{"unparseable", map[string]any{"cpuinfo": "abc%", "memory": "xyz"}, nil, nil},
		{"not an object", "nope", nil, nil},
		{"nil", nil, nil, nil},
	}
	for _, tc := range tests {
		cpu, mem := parseHostMetrics(tc.in)
		switch {
		case (cpu == nil) != (tc.cpu == nil):
			t.Errorf("%s: cpu presence = %v, want %v", tc.name, cpu != nil, tc.cpu != nil)
		case cpu != nil && *cpu != *tc.cpu:
			t.Errorf("%s: cpu = %v, want %v", tc.name, *cpu, *tc.cpu)
		}
		switch {
		case (mem == nil) != (tc.mem == nil):
			t.Errorf("%s: mem presence = %v, want %v", tc.name, mem != nil, tc.mem != nil)
		case mem != nil && *mem != *tc.mem:
			t.Errorf("%s: mem = %v, want %v", tc.name, *mem, *tc.mem)
		}
	}
}

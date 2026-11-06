package main

import (
	"path/filepath"
	"testing"
	"time"
)

// newTestStore gives each test its own on-disk database.
func newTestStore(t *testing.T) *Store {
	t.Helper()
	s, err := openStore(Config{DBPath: filepath.Join(t.TempDir(), "test.db"), MaxPayload: 1024})
	if err != nil {
		t.Fatalf("openStore: %v", err)
	}
	t.Cleanup(func() { _ = s.Close() })
	return s
}

func appendMsg(t *testing.T, s *Store, topic string, ts time.Time, payload string, qos byte, retain bool) {
	t.Helper()
	s.Append(Msg{TS: ts.UnixMilli(), Topic: topic, QoS: qos, Retain: retain, Payload: payload, Bytes: len(payload)})
}

func latestByTopic(t *testing.T, msgs []Msg) map[string]Msg {
	t.Helper()
	out := map[string]Msg{}
	for _, m := range msgs {
		if prev, dup := out[m.Topic]; dup {
			t.Fatalf("topic %q returned twice: %q and %q", m.Topic, prev.Payload, m.Payload)
		}
		out[m.Topic] = m
	}
	return out
}

// The window spans more than one calendar day, which is the case that broke
// REPLACE mode in the UI: a topic whose newest message is yesterday evening
// must still resolve to that message, not to a newer one from another topic.
func TestLatestPerTopicAcrossDays(t *testing.T) {
	s := newTestStore(t)

	today := time.Date(2026, 9, 25, 16, 0, 0, 0, time.UTC)
	yesterday := today.Add(-21 * time.Hour) // 19:00 the previous day

	appendMsg(t, s, "fleet/quiet", yesterday, "quiet-latest", 0, false)
	appendMsg(t, s, "fleet/busy", yesterday.Add(time.Minute), "busy-old", 0, false)
	appendMsg(t, s, "fleet/busy", today, "busy-latest", 0, false)
	if err := s.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	got, err := s.LatestPerTopic(Query{Limit: 100})
	if err != nil {
		t.Fatalf("LatestPerTopic: %v", err)
	}
	by := latestByTopic(t, got)

	if len(by) != 2 {
		t.Fatalf("want 2 topics, got %d: %v", len(by), got)
	}
	if by["fleet/busy"].Payload != "busy-latest" {
		t.Errorf("fleet/busy: want busy-latest, got %q", by["fleet/busy"].Payload)
	}
	// the one the loaded window would have missed entirely
	if by["fleet/quiet"].Payload != "quiet-latest" {
		t.Errorf("fleet/quiet: want quiet-latest, got %q", by["fleet/quiet"].Payload)
	}

	// newest topic first, so the UI can render the rows in arrival order
	if got[0].Topic != "fleet/busy" {
		t.Errorf("want fleet/busy first, got %q", got[0].Topic)
	}
}

// Filters apply before the per-topic max: REPLACE + RETAINED is "each topic's
// latest retained message", not "topics whose latest message is retained".
func TestLatestPerTopicFiltersBeforeMax(t *testing.T) {
	s := newTestStore(t)
	base := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)

	appendMsg(t, s, "fleet/a", base, "a-retained", 1, true)
	appendMsg(t, s, "fleet/a", base.Add(time.Hour), "a-live", 1, false)
	appendMsg(t, s, "fleet/b", base.Add(2*time.Hour), "b-live", 0, false)
	if err := s.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	retained, err := s.LatestPerTopic(Query{Limit: 100, Retained: true})
	if err != nil {
		t.Fatalf("LatestPerTopic: %v", err)
	}
	by := latestByTopic(t, retained)
	if len(by) != 1 {
		t.Fatalf("want only fleet/a, got %d rows: %v", len(by), retained)
	}
	if by["fleet/a"].Payload != "a-retained" {
		t.Errorf("want a-retained, got %q", by["fleet/a"].Payload)
	}

	qos, err := s.LatestPerTopic(Query{Limit: 100, QoS: []int{0}})
	if err != nil {
		t.Fatalf("LatestPerTopic: %v", err)
	}
	if by := latestByTopic(t, qos); len(by) != 1 || by["fleet/b"].Payload != "b-live" {
		t.Errorf("qos 0 filter: got %v", qos)
	}
}

func TestLatestPerTopicScopeAndHorizon(t *testing.T) {
	s := newTestStore(t)
	base := time.Date(2026, 9, 25, 9, 0, 0, 0, time.UTC)

	appendMsg(t, s, "fleet/eu/gw-01", base, "in-scope", 0, false)
	appendMsg(t, s, "fleet/eu", base.Add(time.Minute), "scope-root", 0, false)
	appendMsg(t, s, "fleet/eu-west/gw-02", base.Add(2*time.Minute), "sibling-prefix", 0, false)
	appendMsg(t, s, "other/topic", base.Add(3*time.Minute), "out-of-scope", 0, false)
	if err := s.Flush(); err != nil {
		t.Fatalf("flush: %v", err)
	}

	got, err := s.LatestPerTopic(Query{Limit: 100, Scope: "fleet/eu"})
	if err != nil {
		t.Fatalf("LatestPerTopic: %v", err)
	}
	by := latestByTopic(t, got)
	// "fleet/eu-west" shares the prefix but is not under "fleet/eu"
	if len(by) != 2 {
		t.Fatalf("want fleet/eu and fleet/eu/gw-01, got %d: %v", len(by), got)
	}
	if _, ok := by["fleet/eu-west/gw-02"]; ok {
		t.Error("sibling prefix leaked into the scope")
	}

	// Since is the retention horizon: anything older is already gone from the UI
	fresh, err := s.LatestPerTopic(Query{Limit: 100, Since: base.Add(2 * time.Minute).UnixMilli()})
	if err != nil {
		t.Fatalf("LatestPerTopic: %v", err)
	}
	if by := latestByTopic(t, fresh); len(by) != 2 {
		t.Fatalf("want the 2 topics inside the horizon, got %d: %v", len(by), fresh)
	}
}

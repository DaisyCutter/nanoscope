package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"strconv"
	"strings"
	"time"
)

const (
	defaultLimit = 880  // matches MSG_CAP in the UI
	maxLimit     = 5000 // one "load older" page ceiling
)

type API struct {
	cfg    Config
	store  *Store
	hub    *Hub
	ingest *Ingest
	nano   *NanoMQ
}

func (a *API) Stats() Stats {
	return Stats{
		TotalStored:  a.store.Stored(),
		TopicsActive: a.store.TopicCount(),
		Rate:         a.ingest.Rate(),
		OldestTS:     a.store.OldestTS(),
		RetentionMs:  a.cfg.Retention.Milliseconds(),
		Uptime:       a.nano.Uptime(),
		ClientsCount: a.nano.Count(),
		BrokerConn:   a.ingest.Conn(),
		Version:      a.nano.Version(),
		NodeStatus:   a.nano.NodeStatus(),
		Metrics:      a.nano.Metrics(),
	}
}

func writeJSON(w http.ResponseWriter, code int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		log.Printf("api: encode: %v", err)
	}
}

func intParam(r *http.Request, key string, def int) int {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

func int64Param(r *http.Request, key string, def int64) int64 {
	if v := r.URL.Query().Get(key); v != "" {
		if n, err := strconv.ParseInt(v, 10, 64); err == nil {
			return n
		}
	}
	return def
}

// queryFrom builds a history query from the UI's filter params. The window is
// always clamped to the retention horizon so a stale client can't ask for more
// than we keep.
func (a *API) queryFrom(r *http.Request) Query {
	q := Query{
		Scope:    r.URL.Query().Get("scope"),
		Limit:    intParam(r, "limit", defaultLimit),
		Before:   int64Param(r, "before", 0),
		Retained: r.URL.Query().Get("retained") == "1",
	}
	if q.Limit < 1 {
		q.Limit = defaultLimit
	}
	if q.Limit > maxLimit {
		q.Limit = maxLimit
	}
	horizon := time.Now().Add(-a.cfg.Retention).UnixMilli()
	q.Since = int64Param(r, "since", horizon)
	if q.Since < horizon {
		q.Since = horizon
	}
	if csv := r.URL.Query().Get("qos"); csv != "" {
		for _, part := range strings.Split(csv, ",") {
			if n, err := strconv.Atoi(strings.TrimSpace(part)); err == nil && n >= 0 && n <= 2 {
				q.QoS = append(q.QoS, n)
			}
		}
	}
	return q
}

// handleBootstrap returns everything the UI needs on load: 24h of aggregates
// (topic index + minute buckets) plus one window of recent messages. The raw
// 24h of messages is deliberately NOT sent — the browser could not hold it.
func (a *API) handleBootstrap(w http.ResponseWriter, r *http.Request) {
	since := time.Now().Add(-a.cfg.Retention).UnixMilli()

	buckets, err := a.store.Buckets(since)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	msgs, err := a.store.Messages(a.queryFrom(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}

	writeJSON(w, http.StatusOK, Bootstrap{
		Stats:         a.Stats(),
		Topics:        a.store.Topics(),
		Buckets:       buckets,
		Messages:      msgs,
		BrokerDisplay: a.cfg.Display(),
	})
}

func (a *API) handleMessages(w http.ResponseWriter, r *http.Request) {
	msgs, err := a.store.Messages(a.queryFrom(r))
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

// handleLatest returns one message per topic — each topic's newest inside the
// retention window — so the UI's REPLACE mode covers the whole window rather
// than only the page of history the browser happens to have loaded.
func (a *API) handleLatest(w http.ResponseWriter, r *http.Request) {
	q := a.queryFrom(r)
	q.Before = 0 // paging is meaningless here: there is exactly one row per topic
	if r.URL.Query().Get("limit") == "" {
		// the row count is bounded by the topic count, not by traffic, so the
		// message-window default is the wrong ceiling
		q.Limit = maxLimit
	}

	msgs, err := a.store.LatestPerTopic(q)
	if err != nil {
		http.Error(w, err.Error(), http.StatusInternalServerError)
		return
	}
	writeJSON(w, http.StatusOK, msgs)
}

func (a *API) handleTopics(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.store.Topics())
}

func (a *API) handleClients(w http.ResponseWriter, r *http.Request) {
	c := a.nano.Clients()
	if c == nil {
		c = []ClientRow{}
	}
	writeJSON(w, http.StatusOK, c)
}

func (a *API) handleStats(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, a.Stats())
}

type publishReq struct {
	Topic   string `json:"topic"`
	Payload string `json:"payload"`
	QoS     byte   `json:"qos"`
	Retain  bool   `json:"retain"`
}

func (a *API) handlePublish(w http.ResponseWriter, r *http.Request) {
	var req publishReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "detail": "bad json"})
		return
	}
	if req.Topic == "" {
		writeJSON(w, http.StatusBadRequest, map[string]any{"ok": false, "detail": "topic required"})
		return
	}
	if req.QoS > 2 {
		req.QoS = 0
	}
	ctx, cancel := context.WithTimeout(r.Context(), 5*time.Second)
	defer cancel()

	if err := a.ingest.Publish(ctx, req.Topic, req.Payload, req.QoS, req.Retain); err != nil {
		writeJSON(w, http.StatusOK, map[string]any{"ok": false, "detail": err.Error()})
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{
		"ok":     true,
		"detail": "sent · qos" + strconv.Itoa(int(req.QoS)),
	})
}

func (a *API) Routes(mux *http.ServeMux) {
	mux.HandleFunc("GET /api/bootstrap", a.handleBootstrap)
	mux.HandleFunc("GET /api/messages", a.handleMessages)
	mux.HandleFunc("GET /api/latest", a.handleLatest)
	mux.HandleFunc("GET /api/topics", a.handleTopics)
	mux.HandleFunc("GET /api/clients", a.handleClients)
	mux.HandleFunc("GET /api/stats", a.handleStats)
	mux.HandleFunc("POST /api/publish", a.handlePublish)
	mux.HandleFunc("GET /api/live", a.hub.ServeWS)
	mux.HandleFunc("GET /api/health", func(w http.ResponseWriter, r *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{"ok": true, "conn": a.ingest.Conn()})
	})
}

// cors keeps the vite dev server (a different origin) able to talk to us
// directly, without needing every call routed through its proxy.
func cors(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

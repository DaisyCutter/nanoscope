package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/coder/websocket"
)

type subscriber struct {
	ch chan []byte
}

// Hub fans live messages out to connected browsers. Frames are batched on a
// ticker to match the UI's ~10Hz coalescing rather than writing per message.
type Hub struct {
	mu   sync.RWMutex
	subs map[*subscriber]struct{}

	batchMu sync.Mutex
	batch   []Msg
}

func newHub() *Hub {
	return &Hub{subs: map[*subscriber]struct{}{}}
}

func (h *Hub) add(s *subscriber) {
	h.mu.Lock()
	h.subs[s] = struct{}{}
	h.mu.Unlock()
}

func (h *Hub) remove(s *subscriber) {
	h.mu.Lock()
	delete(h.subs, s)
	h.mu.Unlock()
}

func (h *Hub) Subscribers() int {
	h.mu.RLock()
	defer h.mu.RUnlock()
	return len(h.subs)
}

// Queue adds a message to the next broadcast batch.
func (h *Hub) Queue(m Msg) {
	h.batchMu.Lock()
	h.batch = append(h.batch, m)
	h.batchMu.Unlock()
}

// FlushBatch broadcasts whatever has accumulated. Called on a ~100ms ticker.
func (h *Hub) FlushBatch() {
	h.batchMu.Lock()
	b := h.batch
	h.batch = nil
	h.batchMu.Unlock()

	if len(b) == 0 || h.Subscribers() == 0 {
		return
	}
	h.broadcast(Frame{T: "msgs", Msgs: b})
}

func (h *Hub) BroadcastStats(s Stats) {
	if h.Subscribers() == 0 {
		return
	}
	h.broadcast(Frame{T: "stats", Stats: &s})
}

func (h *Hub) broadcast(f Frame) {
	data, err := json.Marshal(f)
	if err != nil {
		log.Printf("hub: marshal: %v", err)
		return
	}
	h.mu.RLock()
	defer h.mu.RUnlock()
	for s := range h.subs {
		select {
		case s.ch <- data:
		default:
			// Slow consumer: drop the frame rather than stall ingest. The
			// browser can always re-fetch from history, so dropping live
			// frames is the safe failure mode.
		}
	}
}

func (h *Hub) ServeWS(w http.ResponseWriter, r *http.Request) {
	c, err := websocket.Accept(w, r, &websocket.AcceptOptions{
		// LAN operator tool: the UI is served from the vite dev server on a
		// different port, so origin checking is off deliberately.
		InsecureSkipVerify: true,
	})
	if err != nil {
		log.Printf("hub: accept: %v", err)
		return
	}
	defer c.CloseNow()

	sub := &subscriber{ch: make(chan []byte, 64)}
	h.add(sub)
	defer h.remove(sub)

	// We never read from the browser (publish goes over HTTP), so CloseRead
	// gives us a context that cancels when the peer goes away.
	ctx := c.CloseRead(r.Context())

	for {
		select {
		case <-ctx.Done():
			return
		case data := <-sub.ch:
			wctx, cancel := context.WithTimeout(ctx, 5*time.Second)
			err := c.Write(wctx, websocket.MessageText, data)
			cancel()
			if err != nil {
				return
			}
		}
	}
}

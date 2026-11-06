package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"
)

func main() {
	cfg := loadConfig()
	log.SetFlags(log.LstdFlags)
	log.SetPrefix("nanoscope ")

	store, err := openStore(cfg)
	if err != nil {
		log.Fatalf("store: %v", err)
	}
	defer store.Close()
	log.Printf("store: %s — %d messages across %d topics in the last %s",
		cfg.DBPath, store.Stored(), store.TopicCount(), cfg.Retention)

	hub := newHub()
	nano := newNanoMQ(cfg)
	ingest := newIngest(cfg, store, hub)
	api := &API{cfg: cfg, store: store, hub: hub, ingest: ingest, nano: nano}

	ctx, cancel := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer cancel()

	if err := ingest.Start(ctx); err != nil {
		log.Fatalf("mqtt: %v", err)
	}

	stop := make(chan struct{})
	go nano.Run(stop)
	go runTickers(ctx, store, hub, ingest, api, cfg.Retention)

	mux := http.NewServeMux()
	api.Routes(mux)
	if cfg.Static != "" {
		log.Printf("http: serving %s at /", cfg.Static)
		mux.Handle("/", http.FileServer(http.Dir(cfg.Static)))
	}

	srv := &http.Server{Addr: cfg.Listen, Handler: cors(mux)}
	go func() {
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("http: %v", err)
		}
	}()
	log.Printf("http: listening on %s", cfg.Listen)

	<-ctx.Done()
	log.Printf("shutting down")
	close(stop)

	shutCtx, cancelShut := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancelShut()
	_ = srv.Shutdown(shutCtx)

	// Drain whatever is still buffered so a restart doesn't lose the last batch.
	if err := store.Flush(); err != nil {
		log.Printf("final flush: %v", err)
	}
}

func runTickers(ctx context.Context, store *Store, hub *Hub, ingest *Ingest, api *API, retention time.Duration) {
	flush := time.NewTicker(200 * time.Millisecond) // batched disk writes
	fan := time.NewTicker(100 * time.Millisecond)   // live fanout, matches UI coalescing
	sec := time.NewTicker(time.Second)              // rate counter + stat frames
	prune := time.NewTicker(time.Minute)            // retention sweep
	defer flush.Stop()
	defer fan.Stop()
	defer sec.Stop()
	defer prune.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case <-flush.C:
			if err := store.Flush(); err != nil {
				log.Printf("flush: %v", err)
			}
		case <-fan.C:
			hub.FlushBatch()
		case <-sec.C:
			ingest.TickRate()
			if hub.Subscribers() > 0 {
				hub.BroadcastStats(api.Stats())
			}
		case <-prune.C:
			if n, err := store.Prune(time.Now()); err != nil {
				log.Printf("prune: %v", err)
			} else if n > 0 {
				log.Printf("prune: dropped %d messages older than %s", n, retention)
			}
		}
	}
}

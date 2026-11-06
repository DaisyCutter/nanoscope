package main

import (
	"context"
	"errors"
	"log"
	"net/url"
	"sync/atomic"
	"time"

	"github.com/eclipse/paho.golang/autopaho"
	"github.com/eclipse/paho.golang/paho"
)

// clientIDKeys are the MQTT 5 user properties we look in for the publishing
// client id, mirroring the lookup the browser client used to do.
var clientIDKeys = []string{"clientid", "client_id", "client"}

// Ingest owns the broker connection: it subscribes to the firehose, writes
// every message into the 24h store, and mirrors it to connected browsers.
type Ingest struct {
	cfg   Config
	store *Store
	hub   *Hub

	cm   *autopaho.ConnectionManager
	conn atomic.Value // string: connecting|connected|reconnecting|offline

	counter atomic.Int64 // messages so far this second
	rate    atomic.Int64 // messages in the last complete second
}

func newIngest(cfg Config, store *Store, hub *Hub) *Ingest {
	in := &Ingest{cfg: cfg, store: store, hub: hub}
	in.conn.Store("connecting")
	return in
}

func (in *Ingest) Conn() string {
	if v, ok := in.conn.Load().(string); ok {
		return v
	}
	return "connecting"
}

func (in *Ingest) Rate() int { return int(in.rate.Load()) }

// TickRate rolls the per-second counter. Called once a second.
func (in *Ingest) TickRate() {
	in.rate.Store(in.counter.Swap(0))
}

func (in *Ingest) onPublish(pr paho.PublishReceived) (bool, error) {
	p := pr.Packet
	m := Msg{
		TS:      time.Now().UnixMilli(),
		Topic:   p.Topic,
		QoS:     p.QoS,
		Retain:  p.Retain,
		Payload: string(p.Payload),
		Bytes:   len(p.Payload),
	}
	if p.Properties != nil {
		for _, k := range clientIDKeys {
			if v := p.Properties.User.Get(k); v != "" {
				val := v
				m.Client = &val
				break
			}
		}
	}

	stored := in.store.Append(m)
	in.hub.Queue(stored)
	in.counter.Add(1)
	return true, nil
}

func (in *Ingest) Start(ctx context.Context) error {
	u, err := url.Parse(in.cfg.BrokerURL())
	if err != nil {
		return err
	}

	cfg := autopaho.ClientConfig{
		ServerUrls:                    []*url.URL{u},
		KeepAlive:                     30,
		CleanStartOnInitialConnection: true,
		SessionExpiryInterval:         60,
		ConnectRetryDelay:             3 * time.Second,
		OnConnectionUp: func(cm *autopaho.ConnectionManager, _ *paho.Connack) {
			in.conn.Store("connected")
			log.Printf("mqtt: connected to %s", in.cfg.BrokerAddr())
			// '#' does not match topics starting with '$', so $SYS needs its own
			// subscription — same pair the browser client used.
			if _, err := cm.Subscribe(ctx, &paho.Subscribe{
				Subscriptions: []paho.SubscribeOptions{
					{Topic: "#", QoS: 0},
					{Topic: "$SYS/#", QoS: 0},
				},
			}); err != nil {
				log.Printf("mqtt: subscribe failed: %v", err)
			}
		},
		OnConnectError: func(err error) {
			in.conn.Store("reconnecting")
			log.Printf("mqtt: connect error: %v", err)
		},
		ClientConfig: paho.ClientConfig{
			ClientID:          "nanoscope-server",
			OnPublishReceived: []func(paho.PublishReceived) (bool, error){in.onPublish},
			OnClientError: func(err error) {
				in.conn.Store("offline")
				log.Printf("mqtt: client error: %v", err)
			},
			OnServerDisconnect: func(d *paho.Disconnect) {
				in.conn.Store("offline")
				log.Printf("mqtt: server disconnect (reason %d)", d.ReasonCode)
			},
		},
	}

	cm, err := autopaho.NewConnection(ctx, cfg)
	if err != nil {
		return err
	}
	in.cm = cm
	return nil
}

func (in *Ingest) Publish(ctx context.Context, topic, payload string, qos byte, retain bool) error {
	if in.cm == nil {
		return errors.New("broker connection not started")
	}
	_, err := in.cm.Publish(ctx, &paho.Publish{
		Topic:   topic,
		QoS:     qos,
		Retain:  retain,
		Payload: []byte(payload),
	})
	return err
}

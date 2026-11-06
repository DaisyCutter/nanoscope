package main

// Wire types shared with the frontend. These mirror app/src/types.ts —
// the json tags ARE the contract, so keep them in sync with the TS interfaces.

// Msg mirrors the TS `Msg` interface.
type Msg struct {
	ID      string  `json:"id"`
	TS      int64   `json:"ts"`
	Topic   string  `json:"topic"`
	QoS     byte    `json:"qos"`
	Retain  bool    `json:"retain"`
	Payload string  `json:"payload"`
	Bytes   int     `json:"bytes"`
	Client  *string `json:"client"`
}

// TopicStat mirrors the TS `TopicStat`, minus the client-derived throughput
// buckets — the UI rebuilds those from live traffic and the minute series.
type TopicStat struct {
	Path   string `json:"path"`
	QoS    byte   `json:"qos"`
	Retain bool   `json:"retain"`
	LastTS int64  `json:"lastTs"`
	Total  int64  `json:"total"`
}

// ClientRow mirrors the TS `ClientRow`; Subs is `number | string` there.
type ClientRow struct {
	ID        string `json:"id"`
	Addr      string `json:"addr"`
	Subs      any    `json:"subs"`
	IO        string `json:"io"`
	Keepalive string `json:"keepalive"`
	State     string `json:"state"`
}

// Bucket is one minute of throughput. 1440 of these cover a 24h window and
// they survive raw-message pruning, so the long sparkline stays intact.
type Bucket struct {
	Minute int64 `json:"minute"`
	Count  int64 `json:"count"`
	Bytes  int64 `json:"bytes"`
}

type Stats struct {
	TotalStored  int64  `json:"totalStored"`
	TopicsActive int    `json:"topicsActive"`
	Rate         int    `json:"rate"`
	OldestTS     int64  `json:"oldestTs"`
	RetentionMs  int64  `json:"retentionMs"`
	Uptime       string `json:"uptime"`
	ClientsCount *int   `json:"clientsCount"`
	BrokerConn   string `json:"brokerConn"`
	// Version and NodeStatus come from /nodes; empty when the broker did not answer.
	Version    string         `json:"version"`
	NodeStatus string         `json:"nodeStatus"`
	Metrics    *BrokerMetrics `json:"metrics"`
}

// BrokerMetrics is the /prometheus scrape, which carries counters MQTT itself
// never exposes to us — messages the broker dropped, and the high-water marks
// behind the current gauges.
//
// Every field is a pointer because "the broker did not report this" and "the
// broker reported zero" are different facts, and the UI renders them
// differently (— versus 0). NanoMQ 0.21.x always reports memory_usage_max and
// cpu_usage_max as 0, so those two are deliberately not carried here.
type BrokerMetrics struct {
	MsgsIn      *int64   `json:"msgsIn"`
	MsgsOut     *int64   `json:"msgsOut"`
	MsgsDropped *int64   `json:"msgsDropped"`
	Connections *int64   `json:"connections"`
	PeakClients *int64   `json:"peakClients"`
	Subscribers *int64   `json:"subscribers"`
	Memory      *int64   `json:"memory"`
	CPU         *float64 `json:"cpu"`
}

// Bootstrap is the single payload the UI fetches on load: 24h of aggregates
// plus one window of recent messages. Deliberately bounded — we never ship
// 24h of raw messages to the browser.
type Bootstrap struct {
	Stats         Stats       `json:"stats"`
	Topics        []TopicStat `json:"topics"`
	Buckets       []Bucket    `json:"buckets"`
	Messages      []Msg       `json:"messages"`
	BrokerDisplay string      `json:"brokerDisplay"`
}

// Frame is a server->client websocket frame.
type Frame struct {
	T     string `json:"t"`
	Msgs  []Msg  `json:"msgs,omitempty"`
	Stats *Stats `json:"stats,omitempty"`
}

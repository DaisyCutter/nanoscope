package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// NanoMQ polls the broker's HTTP API for the things MQTT itself doesn't give
// us: the client list, broker identity, and the counters behind /prometheus.
// This is a direct port of the best-effort logic in app/src/httpApi.ts —
// missing endpoints or fields degrade to "—" rather than failing the poll.
type NanoMQ struct {
	cfg  Config
	http *http.Client

	mu         sync.RWMutex
	clients    []ClientRow
	uptime     string
	count      *int
	version    string
	nodeStatus string
	metrics    *BrokerMetrics
}

func newNanoMQ(cfg Config) *NanoMQ {
	return &NanoMQ{cfg: cfg, http: &http.Client{Timeout: 4 * time.Second}}
}

func (n *NanoMQ) Clients() []ClientRow {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.clients
}

func (n *NanoMQ) Uptime() string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.uptime
}

func (n *NanoMQ) Count() *int {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.count
}

func (n *NanoMQ) Version() string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.version
}

func (n *NanoMQ) NodeStatus() string {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.nodeStatus
}

func (n *NanoMQ) Metrics() *BrokerMetrics {
	n.mu.RLock()
	defer n.mu.RUnlock()
	return n.metrics
}

func (n *NanoMQ) get(path string) any {
	req, err := http.NewRequest(http.MethodGet, n.cfg.NanoMQBase()+path, nil)
	if err != nil {
		return nil
	}
	req.SetBasicAuth(n.cfg.APIUser, n.cfg.APIPass)
	res, err := n.http.Do(req)
	if err != nil {
		return nil
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return nil
	}
	var v any
	if err := json.NewDecoder(res.Body).Decode(&v); err != nil {
		return nil
	}
	return v
}

// getText fetches an endpoint that answers in something other than JSON.
// /prometheus is the only one, and its body is a couple of KB.
func (n *NanoMQ) getText(path string) string {
	req, err := http.NewRequest(http.MethodGet, n.cfg.NanoMQBase()+path, nil)
	if err != nil {
		return ""
	}
	req.SetBasicAuth(n.cfg.APIUser, n.cfg.APIPass)
	res, err := n.http.Do(req)
	if err != nil {
		return ""
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return ""
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, 64<<10))
	if err != nil {
		return ""
	}
	return string(b)
}

// parsePrometheus reads the slice of the exposition format NanoMQ actually
// emits: "# TYPE"/"# HELP" comments, then bare "name value" lines. There are
// no labels, histograms or timestamps in its output, so anything that does not
// parse as a plain float is skipped rather than guessed at.
func parsePrometheus(body string) map[string]float64 {
	out := map[string]float64{}
	for _, line := range strings.Split(body, "\n") {
		line = strings.TrimSpace(line)
		if line == "" || line[0] == '#' {
			continue
		}
		name, val, ok := strings.Cut(line, " ")
		if !ok {
			continue
		}
		f, err := strconv.ParseFloat(strings.TrimSpace(val), 64)
		if err != nil {
			continue
		}
		out[name] = f
	}
	return out
}

// parseHostMetrics reads the /metrics payload: {"metrics":[],"cpuinfo":"0.01%",
// "memory":"5893948"}. Note the values are strings and the object has no data
// envelope, so neither rows() nor num() applies. Returns nils when absent.
func parseHostMetrics(v any) (*float64, *int64) {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil, nil
	}
	var cpu *float64
	if raw := str(obj, "cpuinfo"); raw != "" {
		if f, err := strconv.ParseFloat(strings.TrimSuffix(raw, "%"), 64); err == nil {
			cpu = &f
		}
	}
	var mem *int64
	if raw := str(obj, "memory"); raw != "" {
		if i, err := strconv.ParseInt(raw, 10, 64); err == nil {
			mem = &i
		}
	} else if f, ok := num(obj, "memory"); ok { // tolerate a numeric build
		i := int64(f)
		mem = &i
	}
	return cpu, mem
}

// rows unwraps NanoMQ's inconsistent {data: [...]} / {data: {data: [...]}} shapes.
func rows(v any) []map[string]any {
	obj, ok := v.(map[string]any)
	if !ok {
		return nil
	}
	data := obj["data"]
	if arr, ok := data.([]any); ok {
		return toMaps(arr)
	}
	if inner, ok := data.(map[string]any); ok {
		for _, k := range []string{"data", "items"} {
			if arr, ok := inner[k].([]any); ok {
				return toMaps(arr)
			}
		}
	}
	return nil
}

func toMaps(arr []any) []map[string]any {
	out := make([]map[string]any, 0, len(arr))
	for _, e := range arr {
		if m, ok := e.(map[string]any); ok {
			out = append(out, m)
		}
	}
	return out
}

func str(m map[string]any, keys ...string) string {
	for _, k := range keys {
		if v, ok := m[k].(string); ok && v != "" {
			return v
		}
	}
	return ""
}

func num(m map[string]any, keys ...string) (float64, bool) {
	for _, k := range keys {
		if v, ok := m[k].(float64); ok {
			return v, true
		}
	}
	return 0, false
}

var (
	reDays  = regexp.MustCompile(`(?i)(\d+)\s*day`)
	reHours = regexp.MustCompile(`(?i)(\d+)\s*hour`)
	reMins  = regexp.MustCompile(`(?i)(\d+)\s*minute`)
)

// uptimeSaneDays bounds what we are willing to believe. NanoMQ 0.21.9-10
// reports a frozen, nonsensical hour count — "5891960 Hours" (~672 years),
// unchanged between polls — which formatted as a seven-digit day count and
// filled the header with garbage. Ten years is comfortably past any real
// broker uptime and well short of that constant.
const uptimeSaneDays = 3650

// parseUptime turns "15 Hours, 4 minutes, 19 seconds" into "0d 15:04".
// It returns "" when the broker reports something implausible, which callers
// treat as "unknown" and the UI renders as —.
func parseUptime(raw string) string {
	grab := func(re *regexp.Regexp) int {
		if m := re.FindStringSubmatch(raw); m != nil {
			n, _ := strconv.Atoi(m[1])
			return n
		}
		return 0
	}
	d, h, m := grab(reDays), grab(reHours), grab(reMins)
	d += h / 24
	h = h % 24
	if d > uptimeSaneDays {
		return ""
	}
	return fmt.Sprintf("%dd %02d:%02d", d, h, m)
}

func fmtCount(n float64) string {
	if n >= 1000 {
		return fmt.Sprintf("%dk", int(n/1000+0.5))
	}
	return strconv.Itoa(int(n))
}

func (n *NanoMQ) Poll() {
	// /metrics is fetched FIRST and on its own, before anything else.
	//
	// NanoMQ computes cpuinfo inside update_process_info(), which both
	// /metrics and /prometheus call, sharing one pair of static baselines
	// (last_cpu_time / last_proc_time). The percentage it returns covers the
	// interval since whichever of those two endpoints was last hit — so
	// firing them together leaves the second one dividing by a near-zero
	// window and reporting quantised nonsense (0%, 14.29%, 25%).
	//
	// Going first gives /metrics the full tick's worth of interval, and
	// leaves the garbage reading on /prometheus's cpu/memory gauges, which
	// are frozen on 0.21.9-10 anyway and only used as a fallback.
	metricsRaw := n.get("/metrics")

	// The rest are independent and safe to fetch concurrently — none of them
	// touch the process-info baselines. The shared http.Client is safe for
	// concurrent use and caps each at 4s.
	var (
		wg                            sync.WaitGroup
		brokers, clients, subs, nodes any
		promBody                      string
	)
	for _, job := range []struct {
		path string
		into *any
	}{
		{"/brokers", &brokers},
		{"/clients", &clients},
		{"/subscriptions", &subs},
		{"/nodes", &nodes},
	} {
		wg.Add(1)
		go func() {
			defer wg.Done()
			*job.into = n.get(job.path)
		}()
	}
	wg.Add(1)
	go func() {
		defer wg.Done()
		promBody = n.getText("/prometheus")
	}()
	wg.Wait()

	prom := parsePrometheus(promBody)

	uptime := ""
	if br := rows(brokers); len(br) > 0 {
		if up := str(br[0], "uptime"); up != "" {
			uptime = parseUptime(up)
		}
	}

	version, nodeStatus := "", ""
	if nd := rows(nodes); len(nd) > 0 {
		version = str(nd[0], "version")
		nodeStatus = str(nd[0], "node_status")
	}

	// /metrics is the live source for process load. Its payload is not wrapped
	// in the usual {code, data} envelope, and both numbers arrive as JSON
	// strings ("1.22%", "5893948") rather than numbers.
	cpuLive, memLive := parseHostMetrics(metricsRaw)

	var metrics *BrokerMetrics
	if len(prom) > 0 || cpuLive != nil || memLive != nil {
		count := func(k string) *int64 {
			v, ok := prom[k]
			if !ok {
				return nil
			}
			i := int64(v)
			return &i
		}
		metrics = &BrokerMetrics{
			MsgsIn:      count("nanomq_messages_received"),
			MsgsOut:     count("nanomq_messages_sent"),
			MsgsDropped: count("nanomq_messages_dropped"),
			Connections: count("nanomq_connections_count"),
			PeakClients: count("nanomq_connections_max"),
			Subscribers: count("nanomq_subscribers_count"),
			CPU:         cpuLive,
			Memory:      memLive,
		}
		// The equivalent /prometheus gauges are frozen on NanoMQ 0.21.9-10 —
		// nanomq_cpu_usage never leaves 0.00 and nanomq_memory_usage never
		// moves — so they are only a fallback for builds without /metrics.
		if metrics.CPU == nil {
			if v, ok := prom["nanomq_cpu_usage"]; ok {
				metrics.CPU = &v
			}
		}
		if metrics.Memory == nil {
			metrics.Memory = count("nanomq_memory_usage")
		}
	}

	subCounts := map[string]int{}
	for _, r := range rows(subs) {
		if cid := str(r, "clientid", "client_id"); cid != "" {
			subCounts[cid]++
		}
	}

	clientRows := rows(clients)
	mapped := make([]ClientRow, 0, len(clientRows))
	for _, r := range clientRows {
		id := str(r, "client_id", "clientid")
		if id == "" {
			id = "?"
		}
		addr := "—"
		if ip := str(r, "ip_address", "ipaddress"); ip != "" {
			addr = ip
			if p, ok := num(r, "port"); ok {
				addr = fmt.Sprintf("%s:%d", ip, int(p))
			}
		}
		var subsVal any = "—"
		if c, ok := subCounts[id]; ok {
			subsVal = c
		} else if v, ok := num(r, "subscriptions_cnt"); ok {
			subsVal = int(v)
		}
		// this broker's /clients rows carry no traffic counters, so this
		// stays "—"; kept for builds/forks that do report them
		ioStr := "—"
		recv, okR := num(r, "recv_msg", "recv_cnt")
		send, okS := num(r, "send_msg", "send_cnt")
		if okR || okS {
			ioStr = fmtCount(recv) + "/" + fmtCount(send)
		}
		keepalive := "—"
		if k, ok := num(r, "keepalive"); ok {
			keepalive = fmt.Sprintf("%ds", int(k))
		}
		state := "CONN"
		if cs := str(r, "conn_state"); cs != "" {
			if cs != "connected" {
				state = "IDLE"
			}
		} else if c, ok := r["connected"].(bool); ok && !c {
			state = "IDLE"
		}
		mapped = append(mapped, ClientRow{
			ID: id, Addr: addr, Subs: subsVal, IO: ioStr, Keepalive: keepalive, State: state,
		})
	}

	n.mu.Lock()
	if uptime != "" {
		n.uptime = uptime
	}
	if version != "" {
		n.version = version
	}
	if nodeStatus != "" {
		n.nodeStatus = nodeStatus
	}
	if metrics != nil {
		n.metrics = metrics
	}
	if len(clientRows) > 0 {
		n.clients = mapped
		c := len(clientRows)
		n.count = &c
	}
	n.mu.Unlock()
}

func (n *NanoMQ) Run(stop <-chan struct{}) {
	n.Poll()
	t := time.NewTicker(5 * time.Second)
	defer t.Stop()
	for {
		select {
		case <-stop:
			return
		case <-t.C:
			n.Poll()
		}
	}
}

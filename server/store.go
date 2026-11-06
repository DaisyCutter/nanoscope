package main

import (
	"database/sql"
	"fmt"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	_ "modernc.org/sqlite"
)

const schemaSQL = `
CREATE TABLE IF NOT EXISTS messages (
  id      INTEGER PRIMARY KEY,
  ts      INTEGER NOT NULL,
  topic   TEXT    NOT NULL,
  qos     INTEGER NOT NULL,
  retain  INTEGER NOT NULL,
  payload TEXT    NOT NULL,
  bytes   INTEGER NOT NULL,
  client  TEXT
);
CREATE INDEX IF NOT EXISTS idx_msg_ts       ON messages(ts);
CREATE INDEX IF NOT EXISTS idx_msg_topic_ts ON messages(topic, ts);

-- One row per wall-clock minute. 1440 rows cover 24h, and they are pruned on a
-- separate schedule from raw messages so the long throughput series stays intact.
CREATE TABLE IF NOT EXISTS buckets (
  minute INTEGER PRIMARY KEY,
  count  INTEGER NOT NULL,
  bytes  INTEGER NOT NULL
);
`

// topicAggSQL recomputes per-topic totals plus the qos/retain of each topic's
// most recent message. The inner GROUP BY is served by idx_msg_topic_ts.
const topicAggSQL = `
SELECT m.topic, c.cnt, m.ts, m.qos, m.retain
FROM messages m
JOIN (SELECT topic, COUNT(*) AS cnt, MAX(id) AS mx FROM messages GROUP BY topic) c
  ON c.topic = m.topic AND c.mx = m.id
`

type Store struct {
	db  *sql.DB
	cfg Config

	seq    atomic.Int64
	stored atomic.Int64

	writeMu sync.Mutex
	pending []Msg

	topicsMu sync.RWMutex
	topics   map[string]TopicStat
}

func openStore(cfg Config) (*Store, error) {
	dsn := cfg.DBPath +
		"?_pragma=journal_mode(WAL)" +
		"&_pragma=synchronous(NORMAL)" +
		"&_pragma=busy_timeout(5000)"
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	db.SetMaxOpenConns(4)
	if _, err := db.Exec(schemaSQL); err != nil {
		return nil, fmt.Errorf("schema: %w", err)
	}

	s := &Store{db: db, cfg: cfg, topics: map[string]TopicStat{}}

	var maxID sql.NullInt64
	if err := db.QueryRow(`SELECT MAX(id) FROM messages`).Scan(&maxID); err != nil {
		return nil, fmt.Errorf("seed seq: %w", err)
	}
	s.seq.Store(maxID.Int64)

	var n int64
	if err := db.QueryRow(`SELECT COUNT(*) FROM messages`).Scan(&n); err != nil {
		return nil, fmt.Errorf("count: %w", err)
	}
	s.stored.Store(n)

	if err := s.RecomputeTopics(); err != nil {
		return nil, fmt.Errorf("topic index: %w", err)
	}
	return s, nil
}

func (s *Store) Close() error { return s.db.Close() }

// Append queues a message for the next batched write and updates the in-memory
// topic index immediately, so the API reflects traffic before it hits disk.
func (s *Store) Append(m Msg) Msg {
	id := s.seq.Add(1)
	m.ID = fmt.Sprint(id)
	if len(m.Payload) > s.cfg.MaxPayload {
		m.Payload = m.Payload[:s.cfg.MaxPayload]
	}

	s.writeMu.Lock()
	s.pending = append(s.pending, m)
	s.writeMu.Unlock()

	s.topicsMu.Lock()
	t := s.topics[m.Topic]
	t.Path = m.Topic
	t.QoS = m.QoS
	t.Retain = m.Retain
	t.LastTS = m.TS
	t.Total++
	s.topics[m.Topic] = t
	s.topicsMu.Unlock()

	return m
}

// Flush writes the queued batch in one transaction. Called on a ticker.
func (s *Store) Flush() error {
	s.writeMu.Lock()
	batch := s.pending
	s.pending = nil
	s.writeMu.Unlock()

	if len(batch) == 0 {
		return nil
	}

	// roll up the batch into per-minute counters before touching the db
	type agg struct{ count, bytes int64 }
	mins := map[int64]*agg{}
	for _, m := range batch {
		k := m.TS / 60000
		a := mins[k]
		if a == nil {
			a = &agg{}
			mins[k] = a
		}
		a.count++
		a.bytes += int64(m.Bytes)
	}

	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	defer func() { _ = tx.Rollback() }()

	ins, err := tx.Prepare(`INSERT INTO messages (id,ts,topic,qos,retain,payload,bytes,client) VALUES (?,?,?,?,?,?,?,?)`)
	if err != nil {
		return err
	}
	defer ins.Close()
	for _, m := range batch {
		var client any
		if m.Client != nil {
			client = *m.Client
		}
		if _, err := ins.Exec(m.ID, m.TS, m.Topic, m.QoS, m.Retain, m.Payload, m.Bytes, client); err != nil {
			return err
		}
	}

	bkt, err := tx.Prepare(`INSERT INTO buckets (minute,count,bytes) VALUES (?,?,?)
		ON CONFLICT(minute) DO UPDATE SET count=count+excluded.count, bytes=bytes+excluded.bytes`)
	if err != nil {
		return err
	}
	defer bkt.Close()
	for k, a := range mins {
		if _, err := bkt.Exec(k, a.count, a.bytes); err != nil {
			return err
		}
	}

	if err := tx.Commit(); err != nil {
		return err
	}
	s.stored.Add(int64(len(batch)))
	return nil
}

// Prune drops everything outside the retention window. Returns rows deleted.
func (s *Store) Prune(now time.Time) (int64, error) {
	cutoff := now.Add(-s.cfg.Retention).UnixMilli()
	res, err := s.db.Exec(`DELETE FROM messages WHERE ts < ?`, cutoff)
	if err != nil {
		return 0, err
	}
	n, _ := res.RowsAffected()
	if _, err := s.db.Exec(`DELETE FROM buckets WHERE minute < ?`, cutoff/60000); err != nil {
		return n, err
	}
	if n > 0 {
		s.stored.Add(-n)
		if err := s.RecomputeTopics(); err != nil {
			return n, err
		}
	}
	return n, nil
}

// RecomputeTopics rebuilds the in-memory topic index from what is actually
// still inside the retention window.
func (s *Store) RecomputeTopics() error {
	rows, err := s.db.Query(topicAggSQL)
	if err != nil {
		return err
	}
	defer rows.Close()

	next := map[string]TopicStat{}
	for rows.Next() {
		var t TopicStat
		if err := rows.Scan(&t.Path, &t.Total, &t.LastTS, &t.QoS, &t.Retain); err != nil {
			return err
		}
		next[t.Path] = t
	}
	if err := rows.Err(); err != nil {
		return err
	}

	s.topicsMu.Lock()
	s.topics = next
	s.topicsMu.Unlock()
	return nil
}

func (s *Store) Topics() []TopicStat {
	s.topicsMu.RLock()
	defer s.topicsMu.RUnlock()
	out := make([]TopicStat, 0, len(s.topics))
	for _, t := range s.topics {
		out = append(out, t)
	}
	return out
}

func (s *Store) TopicCount() int {
	s.topicsMu.RLock()
	defer s.topicsMu.RUnlock()
	return len(s.topics)
}

func (s *Store) Stored() int64 { return s.stored.Load() }

func (s *Store) OldestTS() int64 {
	var v sql.NullInt64
	if err := s.db.QueryRow(`SELECT MIN(ts) FROM messages`).Scan(&v); err != nil {
		return 0
	}
	return v.Int64
}

// Query describes a message-history request from the UI.
type Query struct {
	Scope    string
	Limit    int
	Before   int64 // exclusive id cursor; 0 means "from newest"
	Since    int64 // unix millis lower bound; 0 means "whole window"
	QoS      []int
	Retained bool
}

// likeEscape makes a topic prefix safe to use in a LIKE pattern.
func likeEscape(s string) string {
	r := strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`)
	return r.Replace(s)
}

// msgSelect is the column list every message query returns, in the order
// scanMsgs reads them.
const msgSelect = `SELECT id,ts,topic,qos,retain,payload,bytes,client FROM messages`

// filters turns a Query's predicates into a WHERE fragment and its arguments.
// Shared so that Messages and LatestPerTopic can never drift apart on what
// "matching" means.
func (q Query) filters() (string, []any) {
	var where []string
	var args []any

	if q.Scope != "" {
		where = append(where, `(topic = ? OR topic LIKE ? ESCAPE '\')`)
		args = append(args, q.Scope, likeEscape(q.Scope)+`/%`)
	}
	if q.Before > 0 {
		where = append(where, `id < ?`)
		args = append(args, q.Before)
	}
	if q.Since > 0 {
		where = append(where, `ts >= ?`)
		args = append(args, q.Since)
	}
	if len(q.QoS) > 0 && len(q.QoS) < 3 {
		ph := make([]string, len(q.QoS))
		for i, v := range q.QoS {
			ph[i] = "?"
			args = append(args, v)
		}
		where = append(where, `qos IN (`+strings.Join(ph, ",")+`)`)
	}
	if q.Retained {
		where = append(where, `retain = 1`)
	}

	if len(where) == 0 {
		return "", nil
	}
	return ` WHERE ` + strings.Join(where, " AND "), args
}

func scanMsgs(rows *sql.Rows, capHint int) ([]Msg, error) {
	out := make([]Msg, 0, capHint)
	for rows.Next() {
		var m Msg
		var id int64
		var client sql.NullString
		if err := rows.Scan(&id, &m.TS, &m.Topic, &m.QoS, &m.Retain, &m.Payload, &m.Bytes, &client); err != nil {
			return nil, err
		}
		m.ID = fmt.Sprint(id)
		if client.Valid {
			c := client.String
			m.Client = &c
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

func (s *Store) Messages(q Query) ([]Msg, error) {
	clause, args := q.filters()
	args = append(args, q.Limit)

	rows, err := s.db.Query(msgSelect+clause+` ORDER BY id DESC LIMIT ?`, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMsgs(rows, q.Limit)
}

// LatestPerTopic returns the newest matching message of every topic, newest
// topic first. This is what the UI's REPLACE mode needs: the browser's loaded
// window only reaches as far back as it has paged, so a topic that last
// published hours ago is missing from it entirely even though we still hold it.
//
// The filters are applied *before* the per-topic max, so REPLACE + RETAINED
// means "each topic's latest retained message" rather than "the topics whose
// single latest message happens to be retained".
func (s *Store) LatestPerTopic(q Query) ([]Msg, error) {
	clause, args := q.filters()
	args = append(args, q.Limit)

	sqlStr := msgSelect + ` WHERE id IN (SELECT MAX(id) FROM messages` + clause +
		` GROUP BY topic) ORDER BY id DESC LIMIT ?`

	rows, err := s.db.Query(sqlStr, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	return scanMsgs(rows, q.Limit)
}

func (s *Store) Buckets(since int64) ([]Bucket, error) {
	rows, err := s.db.Query(`SELECT minute,count,bytes FROM buckets WHERE minute >= ? ORDER BY minute`, since/60000)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	var out []Bucket
	for rows.Next() {
		var b Bucket
		if err := rows.Scan(&b.Minute, &b.Count, &b.Bytes); err != nil {
			return nil, err
		}
		out = append(out, b)
	}
	return out, rows.Err()
}

package main

import (
	"flag"
	"fmt"
	"os"
	"strconv"
	"time"

	"github.com/joho/godotenv"
)

type Config struct {
	BrokerHost string
	BrokerPort int
	APIPort    int
	APIUser    string
	APIPass    string
	Listen     string
	DBPath     string
	Retention  time.Duration
	// MaxPayload caps what we store per message; larger payloads are truncated
	// so one pathological publisher can't blow up the 24h window.
	MaxPayload int
	// Static optionally serves a built frontend (app/dist) from this server.
	Static string
}

func (c Config) BrokerAddr() string { return fmt.Sprintf("%s:%d", c.BrokerHost, c.BrokerPort) }
func (c Config) BrokerURL() string  { return fmt.Sprintf("mqtt://%s:%d", c.BrokerHost, c.BrokerPort) }
func (c Config) Display() string    { return fmt.Sprintf("nanomq://%s:%d", c.BrokerHost, c.BrokerPort) }
func (c Config) NanoMQBase() string {
	return fmt.Sprintf("http://%s:%d/api/v4", c.BrokerHost, c.APIPort)
}

func envOr(k, def string) string {
	if v := os.Getenv(k); v != "" {
		return v
	}
	return def
}

func envInt(k string, def int) int {
	if v := os.Getenv(k); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			return n
		}
	}
	return def
}

// Load the first existing file; exported environment variables retain precedence.
func loadLocalEnv(paths ...string) error {
	for _, path := range paths {
		if _, err := os.Stat(path); os.IsNotExist(err) {
			continue
		} else if err != nil {
			return fmt.Errorf("cannot read env file %s", path)
		}
		if err := godotenv.Load(path); err != nil {
			return fmt.Errorf("cannot parse env file %s", path)
		}
		return nil
	}
	return nil
}

func loadConfig() Config {
	if err := loadLocalEnv(".env", "../.env"); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var c Config
	flag.StringVar(&c.BrokerHost, "broker-host", envOr("MQTT_HOST", "127.0.0.1"), "MQTT broker host")
	flag.IntVar(&c.BrokerPort, "broker-port", envInt("MQTT_PORT", 1883), "MQTT broker TCP port")
	flag.IntVar(&c.APIPort, "api-port", envInt("MQTT_API_PORT", 8081), "NanoMQ HTTP API port")
	flag.StringVar(&c.APIUser, "api-user", envOr("MQTT_API_USER", ""), "NanoMQ HTTP API user")
	flag.StringVar(&c.APIPass, "api-pass", envOr("MQTT_API_PASS", ""), "NanoMQ HTTP API password")
	flag.StringVar(&c.Listen, "listen", envOr("LISTEN", ":8090"), "HTTP listen address")
	flag.StringVar(&c.DBPath, "db", envOr("DB_PATH", "nanoscope.db"), "SQLite database path")
	flag.DurationVar(&c.Retention, "retention", 24*time.Hour, "how long to keep raw messages")
	flag.IntVar(&c.MaxPayload, "max-payload", envInt("MAX_PAYLOAD", 64*1024), "max stored payload bytes")
	flag.StringVar(&c.Static, "static", envOr("STATIC_DIR", ""), "serve a built frontend from this directory")
	flag.Parse()
	return c
}

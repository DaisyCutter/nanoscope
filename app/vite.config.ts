import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { WebSocketServer } from 'ws'
import net from 'node:net'
import { fileURLToPath } from 'node:url'

// The broker only listens on raw TCP (1883) — browsers can't speak that, so the dev
// server bridges MQTT-over-WebSocket at /mqtt to a TCP socket, byte-for-byte.
function mqttBridge(brokerHost: string, brokerPort: number): Plugin {
  return {
    name: 'mqtt-ws-bridge',
    configureServer(server) {
      const wss = new WebSocketServer({
        noServer: true,
        handleProtocols: (protocols) => (protocols.has('mqtt') ? 'mqtt' : false),
      })
      server.httpServer?.on('upgrade', (req, socket, head) => {
        if (!req.url || new URL(req.url, 'http://x').pathname !== '/mqtt') return
        wss.handleUpgrade(req, socket, head, (ws) => {
          const tcp = net.connect(brokerPort, brokerHost)
          ws.on('message', (data) => tcp.write(data as Buffer))
          tcp.on('data', (d) => {
            if (ws.readyState === ws.OPEN) ws.send(d)
          })
          ws.on('close', () => tcp.destroy())
          ws.on('error', () => tcp.destroy())
          tcp.on('close', () => ws.close())
          tcp.on('error', () => ws.close())
        })
      })
    },
  }
}

export default defineConfig(({ mode }) => {
  const envDir = fileURLToPath(new URL('..', import.meta.url))
  // Only explicitly selected non-secret values below are embedded in the browser.
  const env = { ...loadEnv(mode, envDir, ''), ...process.env }
  const BROKER_HOST = env.MQTT_HOST ?? '127.0.0.1'
  const BROKER_PORT = Number(env.MQTT_PORT ?? 1883)
  const HTTP_API = `http://${BROKER_HOST}:${Number(env.MQTT_API_PORT ?? 8081)}`
  const SERVER = env.NANOSCOPE_SERVER ?? 'http://127.0.0.1:8090'
  const DEFAULT_MODE = env.NANOSCOPE_MODE ?? 'server'
  const apiAuth = 'Basic ' + Buffer.from(
    `${env.MQTT_API_USER ?? ''}:${env.MQTT_API_PASS ?? ''}`,
  ).toString('base64')
  return {
    plugins: [react(), mqttBridge(BROKER_HOST, BROKER_PORT)],
    define: {
      __BROKER_DISPLAY__: JSON.stringify(`nanomq://${BROKER_HOST}:${BROKER_PORT}`),
      __DEFAULT_MODE__: JSON.stringify(DEFAULT_MODE),
    },
    server: {
      host: true,
      port: 5180,
      strictPort: true,
      // /hapi is proxied to the NanoMQ HTTP API so the browser avoids CORS
      proxy: {
        // REST + the live websocket both go to the Go backend
        '/api': {
          target: SERVER,
          changeOrigin: true,
          ws: true,
        },
        '/hapi': {
          target: HTTP_API,
          configure: (proxy) => {
            proxy.on('proxyReq', (req) => req.setHeader('Authorization', apiAuth))
          },
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/hapi/, ''),
        },
      },
    },
  }
})

import mqtt from 'mqtt'
import { startPolling } from '../httpApi'
import { store } from '../store'
import { SUBSCRIPTIONS } from '../config'

let client: mqtt.MqttClient | null = null

export function connect(): void {
  const url = store.state.brokerUrl
  client = mqtt.connect(url, {
    protocolVersion: 5,
    clientId: 'nanoscope-' + Math.random().toString(16).slice(2, 8),
    keepalive: 30,
    reconnectPeriod: 3000,
    connectTimeout: 8000,
  })

  client.on('connect', () => {
    store.set({ conn: 'connected', connError: null })
    for (const t of SUBSCRIPTIONS) {
      client!.subscribe(t, { qos: 0 }, (err) => {
        if (err) console.warn('subscribe failed', t, err)
      })
    }
  })

  client.on('reconnect', () => store.set({ conn: 'reconnecting' }))
  client.on('close', () => {
    if (store.state.conn !== 'reconnecting') store.set({ conn: 'offline' })
  })
  client.on('error', (err) => store.set({ connError: err.message }))

  startPolling()

  client.on('message', (topic, payload, packet) => {
    const props = (packet as { properties?: { userProperties?: Record<string, string | string[]> } }).properties
    const up = props?.userProperties
    const rawClient = up?.clientid ?? up?.client_id ?? up?.client ?? null
    store.ingest({
      ts: Date.now(),
      topic,
      qos: packet.qos as 0 | 1 | 2,
      retain: packet.retain,
      payload: payload.toString(),
      bytes: payload.length,
      client: Array.isArray(rawClient) ? rawClient[0] : rawClient,
    })
  })
}

/** live mode holds nothing before the tab opened, so there is no older page */
export function loadOlder(): Promise<void> {
  return Promise.resolve()
}

/** live mode filters the in-memory ring; nothing to re-fetch on scope change */
export function loadScope(): Promise<void> {
  return Promise.resolve()
}

export async function publish(topic: string, body: string, qos: 0 | 1 | 2, retain: boolean): Promise<void> {
  if (!client || !client.connected) {
    store.set({ pubStatus: { text: '✗ not connected to broker', ok: false } })
    return
  }
  client.publish(topic, body, { qos, retain }, (err, packet) => {
    if (err) {
      store.set({ pubStatus: { text: '✗ ' + err.message, ok: false } })
    } else {
      const pid = packet && 'messageId' in packet ? ' · packet 0x' + Number(packet.messageId).toString(16) : ''
      store.set({ pubStatus: { text: '✓ sent' + pid + ' · qos' + qos, ok: true } })
    }
  })
}

import { sourceMode } from '../config'
import * as live from './live'
import * as server from './server'

/**
 * The data-source seam. Both implementations feed the same store; only where
 * messages come from differs — the browser's own MQTT connection (live, no
 * history) or the Go backend (server, full retention window on load).
 */
export interface Source {
  connect(): void
  publish(topic: string, body: string, qos: 0 | 1 | 2, retain: boolean): Promise<void>
  loadOlder(): Promise<void>
}

export const mode = sourceMode()

const impl: Source = mode === 'server' ? server : live

export function connect(): void {
  impl.connect()
}

export function publish(topic: string, body: string, qos: 0 | 1 | 2, retain: boolean): void {
  void impl.publish(topic, body, qos, retain)
}

export function loadOlder(): Promise<void> {
  return impl.loadOlder()
}

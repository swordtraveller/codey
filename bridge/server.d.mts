import type { Server } from 'node:http'

export function startBridgeServer(port?: number, host?: string): Promise<Server>
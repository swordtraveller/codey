import { startBridgeServer } from './server.mjs'

const [command, ...args] = process.argv.slice(2)
if (command !== 'start') {
  console.error('Usage: node bridge/cli.mjs start [--port 8787]')
  process.exit(1)
}
const index = args.indexOf('--port')
const port = index >= 0 ? Number(args[index + 1]) : 8787
const server = await startBridgeServer(Number.isInteger(port) ? port : 8787, process.env.BRIDGE_HOST || '0.0.0.0')
console.log(`Bridge listening on http://${process.env.BRIDGE_HOST || '0.0.0.0'}:${port}`)
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)))

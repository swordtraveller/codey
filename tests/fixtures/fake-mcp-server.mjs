import readline from 'node:readline'

process.stderr.write('fake-mcp ready\n')

const tools = [
  {
    name: 'echo',
    description: 'Echo text back to the caller.',
    inputSchema: {
      type: 'object',
      properties: { text: { type: 'string' } },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'fail',
    description: 'Return an MCP tool error.',
    inputSchema: {
      type: 'object',
      properties: { message: { type: 'string' } },
      additionalProperties: false,
    },
  },
  {
    name: 'inspect',
    description: 'Inspect the test server process.',
    inputSchema: { type: 'object', additionalProperties: false },
  },
]

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`)
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value })
}

const input = readline.createInterface({ input: process.stdin, crlfDelay: Infinity })
input.on('line', (line) => {
  if (!line.trim()) return

  let request
  try {
    request = JSON.parse(line)
  } catch {
    return
  }

  if (request.method === 'initialize') {
    result(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: {} },
      serverInfo: { name: 'fake-mcp', version: '1.2.3' },
    })
    return
  }

  if (request.method === 'notifications/initialized') return

  if (request.method === 'tools/list') {
    result(request.id, { tools })
    return
  }

  if (request.method === 'tools/call') {
    const name = request.params?.name
    const args = request.params?.arguments ?? {}
    if (name === 'echo') {
      result(request.id, { content: [{ type: 'text', text: String(args.text ?? '') }] })
      return
    }
    if (name === 'fail') {
      result(request.id, {
        isError: true,
        content: [{ type: 'text', text: String(args.message ?? 'expected failure') }],
      })
      return
    }
    if (name === 'inspect') {
      result(request.id, {
        content: [{
          type: 'text',
          text: JSON.stringify({ cwd: process.cwd(), env: process.env.FAKE_ENV, pid: process.pid }),
        }],
      })
      return
    }
    send({
      jsonrpc: '2.0',
      id: request.id,
      error: { code: -32601, message: `Unknown tool: ${name}` },
    })
  }
})

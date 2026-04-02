import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { DefaultAzureCredential } from '@azure/identity'
import { ServiceBusClient } from '@azure/service-bus'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SB_FQDN = process.env.SERVICE_BUS_FQDN || 'vidaugment-bus.servicebus.windows.net'
const SB_QUEUE = 'moments'
const PORT = process.env.PORT || 3000

// Cross-tenant: AZURE_CLIENT_ID = Charité MI clientId
//               AZURE_TENANT_ID = vidaugment tenant (token exchange target)
const credential = new DefaultAzureCredential({
  managedIdentityClientId: process.env.AZURE_CLIENT_ID
})

// Active SSE clients
const clients = new Set()

// In-memory store: masterSessionId → [moments chunks]
const sessions = new Map()

async function pollServiceBus () {
  const sbClient = new ServiceBusClient(SB_FQDN, credential)
  const receiver = sbClient.createReceiver(SB_QUEUE, { receiveMode: 'receiveAndDelete' })

  console.log(`[sb] Polling ${SB_FQDN}/${SB_QUEUE}`)

  for (;;) {
    try {
      const messages = await receiver.receiveMessages(10, { maxWaitTimeInMs: 5000 })
      for (const msg of messages) {
        const event = msg.body
        // Event Grid wraps in array when delivered via SB
        const data = Array.isArray(event) ? event[0].data : (event.data ?? event)
        const { masterSessionId, sessionId, chunkIndex, capturedAt, moments } = data

        if (!sessions.has(masterSessionId)) sessions.set(masterSessionId, [])
        sessions.get(masterSessionId).push({ sessionId, chunkIndex, capturedAt, moments })

        const payload = JSON.stringify({ masterSessionId, sessionId, chunkIndex, capturedAt, moments })
        for (const res of clients) {
          res.write(`data: ${payload}\n\n`)
        }
        console.log(`[sb] masterSession=${masterSessionId} chunk=${chunkIndex} moments=${moments?.length}`)
      }
    } catch (err) {
      console.error('[sb] poll error', err.message)
      await new Promise(r => setTimeout(r, 5000))
    }
  }
}

const server = http.createServer((req, res) => {
  if (req.url === '/stream') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': '*'
    })
    // Send current state immediately on connect
    for (const [masterSessionId, chunks] of sessions) {
      for (const chunk of chunks) {
        res.write(`data: ${JSON.stringify({ masterSessionId, ...chunk })}\n\n`)
      }
    }
    clients.add(res)
    req.on('close', () => clients.delete(res))
    return
  }

  if (req.url === '/' || req.url === '/index.html') {
    const html = fs.readFileSync(path.join(__dirname, 'index.html'))
    res.writeHead(200, { 'Content-Type': 'text/html' })
    res.end(html)
    return
  }

  res.writeHead(404)
  res.end()
})

server.listen(PORT, () => console.log(`[server] http://localhost:${PORT}`))
pollServiceBus()

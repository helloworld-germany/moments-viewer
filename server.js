import http from 'http'
import fs from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'
import { ServiceBusClient } from '@azure/service-bus'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SB_FQDN = process.env.SERVICE_BUS_FQDN || 'vidaugment-bus.servicebus.windows.net'
const SB_QUEUE = 'moments'
const PORT = process.env.PORT || 3000

// Cross-tenant auth via client_secret (stored as Container App secret)
// AZURE_APP_CLIENT_ID + AZURE_CLIENT_SECRET → vidaugment tenant token → Service Bus
async function getServiceBusToken () {
  const params = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: process.env.AZURE_APP_CLIENT_ID,
    client_secret: process.env.AZURE_CLIENT_SECRET,
    scope: 'https://servicebus.azure.net/.default'
  })
  const res = await fetch(
    `https://login.microsoftonline.com/${process.env.AZURE_TENANT_ID}/oauth2/v2.0/token`,
    { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString() }
  )
  if (!res.ok) throw new Error(`Token request failed: ${res.status} ${await res.text()}`)
  const json = await res.json()
  return { token: json.access_token, expiresOnTimestamp: Date.now() + (json.expires_in - 60) * 1000 }
}

// TokenCredential interface for @azure/service-bus
let cachedToken = null
const credential = {
  getToken: async () => {
    if (!cachedToken || cachedToken.expiresOnTimestamp < Date.now()) {
      cachedToken = await getServiceBusToken()
      console.log('[identity] Token refreshed, expires in', Math.round((cachedToken.expiresOnTimestamp - Date.now()) / 60000), 'min')
    }
    return cachedToken
  }
}


// Active SSE clients
const clients = new Set()

// In-memory store: masterSessionId → { chunks: [], lastSeen: timestamp }
const sessions = new Map()

// Purge sessions not updated in the last 2 hours
setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000
  for (const [id, s] of sessions) {
    if (s.lastSeen < cutoff) sessions.delete(id)
  }
}, 10 * 60 * 1000)

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

        if (!sessions.has(masterSessionId)) sessions.set(masterSessionId, { chunks: [], lastSeen: Date.now() })
        const session = sessions.get(masterSessionId)
        session.chunks.push({ sessionId, chunkIndex, capturedAt, moments })
        session.lastSeen = Date.now()

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
    for (const [masterSessionId, s] of sessions) {
      for (const chunk of s.chunks) {
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

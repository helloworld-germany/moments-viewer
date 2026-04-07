# moments-viewer

Live stream viewer for `vidaugment.moments.extracted` events. Connects to the vidaugment Azure Service Bus queue and displays moments in real-time as AV extractions complete.

## Architecture

Each consumer gets a **dedicated Service Bus queue**. Event Grid fans out a copy of every event to all subscribed queues independently — consumers do not share messages.

```
vidaugment tenant                           Consumer tenant
─────────────────────────────               ──────────────────────────────
Azure Function                              Consumer application
  → Event Grid Topic (private)              (any language / runtime)
  → Service Bus queue "moments-X"  ←─pulls── client_credentials grant
    (public, Entra auth only)                app reg in vidaugment tenant
```

This repo is the reference implementation (browser-based viewer). For programmatic integrations, see [Event payload](#event-payload) below.

## Event payload

Every message on the queue is an Event Grid envelope delivered as JSON:

```json
{
  "id": "...",
  "eventType": "vidaugment.moments.extracted",
  "subject": "masterSession/{masterSessionId}/chunk/{chunkIndex}",
  "eventTime": "2026-04-03T13:16:57Z",
  "dataVersion": "1.0",
  "data": {
    "masterSessionId": "YNuaDHDL3F",
    "sessionId": "mave3xTJkY",
    "chunkIndex": 0,
    "capturedAt": "2026-04-03T13:16:45Z",
    "moments": [
      {
        "id": "...",
        "startMs": 0,
        "endMs": 20000,
        "spokenText": "...",
        "visibleText": "...",
        "text": "...",
        "segmentIds": ["..."]
      }
    ],
    "videoBlobUrl": "https://....blob.core.windows.net/raw/....mp4?sv=...&sig=...&se=...",
    "context": null
  }
}
```

- `moments` — normalised ASR (`spokenText`) and OCR (`visibleText`) segments for this 20-second chunk
- `videoBlobUrl` — time-limited SAS URL (15 min) to the raw video segment; download promptly
- `context` — reserved for NIDA integration, currently `null`
- `chunkIndex` — zero-based position of this recording within the master session

## Onboarding a consumer

These steps are performed by the vidaugment operator. Contact the operator to initiate onboarding; provide the name of your application.

**The operator runs the following once per consumer:**

```bash
CONSUMER=<short-name>   # e.g. "myapp"

# 1. Dedicated queue
az servicebus queue create \
  --name "moments-${CONSUMER}" \
  --namespace-name <servicebus-namespace> \
  --resource-group <resource-group> \
  --default-message-time-to-live P1D

# 2. Event Grid subscription (fan-out copy)
az eventgrid event-subscription create \
  --name "moments-to-${CONSUMER}" \
  --source-resource-id "<eventgrid-topic-resource-id>" \
  --endpoint-type servicebusqueue \
  --endpoint "<servicebus-queue-resource-id-for-consumer>" \
  --delivery-identity systemassigned \
  --delivery-identity-endpoint "<servicebus-queue-resource-id-for-consumer>" \
  --delivery-identity-endpoint-type ServiceBusQueue

# 3. App registration for the consumer
az ad app create --display-name "vidaugment-sb-reader-${CONSUMER}"
# note the returned appId

az ad sp create --id <appId>
# note the returned id (SP object ID)

# 4. Grant read access to the dedicated queue
az role assignment create \
  --assignee-object-id <sp-object-id> \
  --assignee-principal-type ServicePrincipal \
  --role "Azure Service Bus Data Receiver" \
  --scope "<servicebus-queue-resource-id-for-consumer>"

# 5. Issue a client secret (1 year)
az ad app credential reset --id <appId> --years 1
# share the returned password with the consumer securely
```

**Hand the consumer:**

| Value | Description |
|---|---|
| `AZURE_TENANT_ID` | vidaugment Entra tenant ID |
| `AZURE_APP_CLIENT_ID` | The `appId` from step 3 |
| `AZURE_CLIENT_SECRET` | The secret from step 5 |
| `SERVICE_BUS_FQDN` | Service Bus namespace FQDN |
| `SERVICE_BUS_QUEUE` | `moments-<short-name>` |

## Deploying this viewer (Azure Container Apps)

This section applies specifically to deploying the browser-based viewer. For other integrations, the prerequisites above are sufficient.

### Passwordless deployment with managed identity (recommended) ✨

The application uses `DefaultAzureCredential` and supports authentication without storing secrets. This is the **recommended approach** for running on Azure.

**Prerequisites:**
- Your consumer application has a managed identity (either system-assigned or user-assigned)
- Share the following with the vidaugment operator:
  - Your Azure **tenant ID** (where the managed identity exists)
  - The **object ID** of your managed identity

**The operator will:**
1. Grant your managed identity the "Azure Service Bus Data Receiver" role on your `moments-<short-name>` queue
2. Confirm completion

**Deployment (no secrets to manage):**

```bash
az containerapp up \
  --name moments-viewer \
  --resource-group <your-rg> \
  --source https://github.com/helloworld-germany/moments-viewer \
  --system-assigned-identity \
  --env-vars \
    "SERVICE_BUS_FQDN=vidaugment-bus.servicebus.windows.net"
```

The system-assigned managed identity is created automatically. Provide its **object ID** to the operator.

**Verify it works:**

```bash
az containerapp logs show -n moments-viewer -g <your-rg> --tail 20
```

You should see:
```
[sb] Polling vidaugment-bus.servicebus.windows.net/moments
[identity] Authenticated with managed identity
```

---

### Password-based deployment (alternative)

If managed identity is not available in your environment, you can use a client secret instead.

### 1. Create a resource group (if needed)

```bash
az group create --name <your-rg> --location swedencentral
```

### 2. Deploy

```bash
az containerapp up \
  --name moments-viewer \
  --resource-group <your-rg> \
  --source https://github.com/helloworld-germany/moments-viewer \
  --env-vars \
    "AZURE_TENANT_ID=<vidaugment-tenant-id>" \
    "AZURE_APP_CLIENT_ID=<app-reg-client-id>" \
    "SERVICE_BUS_FQDN=vidaugment-bus.servicebus.windows.net"
```

### 3. Store the client secret securely

```bash
az containerapp secret set \
  --name moments-viewer \
  --resource-group <your-rg> \
  --secrets "sb-client-secret=<your-client-secret>"

az containerapp update \
  --name moments-viewer \
  --resource-group <your-rg> \
  --set-env-vars \
    "AZURE_TENANT_ID=<vidaugment-tenant-id>" \
    "AZURE_APP_CLIENT_ID=<app-reg-client-id>" \
    "SERVICE_BUS_FQDN=vidaugment-bus.servicebus.windows.net" \
    "AZURE_CLIENT_SECRET=secretref:sb-client-secret"
```

### 4. Get the URL

```bash
az containerapp show \
  --name moments-viewer \
  --resource-group <your-rg> \
  --query "properties.configuration.ingress.fqdn" -o tsv
```

Open `https://<fqdn>` in a browser — moments appear in real-time as vidaugment processes recordings.

## Updating the container

Build from GitHub source and update the image — preserves all env vars, secrets, and managed identity:

```bash
az acr build \
  --registry <your-acr-name> \
  --image moments-viewer:latest \
  https://github.com/helloworld-germany/moments-viewer

az containerapp update \
  --name moments-viewer \
  --resource-group <your-rg> \
  --image <your-acr-name>.azurecr.io/moments-viewer:latest
```

## Local development

**With managed identity (recommended):**
```bash
npm install
SERVICE_BUS_FQDN=vidaugment-bus.servicebus.windows.net node server.js
```

The app will authenticate using `DefaultAzureCredential` (local Azure CLI credentials, Visual Studio Code Azure sign-in, or environment variables).

**With client secret (alternative):**
```bash
npm install
AZURE_TENANT_ID=... AZURE_APP_CLIENT_ID=... AZURE_CLIENT_SECRET=... SERVICE_BUS_FQDN=vidaugment-bus.servicebus.windows.net node server.js
```

Open `http://localhost:3000`.

## What gets displayed

Each moment has a time range (MM:SS), spoken content (ASR), and visible content (OCR), grouped by master session ID. Moments arrive within seconds of a vidaugment extraction completing.

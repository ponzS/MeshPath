# MeshPath Mesh Chat (Client-driven Replication)

[中文文档 / Chinese Version](./MESH_CHAT_DESIGN.md)

---

## 1. Client-side Logic and Principles

### 1.1 Core Modules
- useMeshChat (text rooms & messages)
  - Send: pack → encrypt → compute message ID → broadcast to all enabled servers
  - Receive: poll /pool/list → parse → decrypt → verify → dedupe & store → client relay to other servers
- useUser (profile & server list)
  - Maintain keypair and server list ({ url, enabled })
- Dexie (IndexedDB)
  - textRooms, textMessages for persistence and dedupe
- unsea crypto
  - Encrypt/decrypt payload, sign/verify `${roomId}:${msg}:${ts}`

### 1.2 Data Flows
- Send (client → multi servers)
```mermaid
sequenceDiagram
  participant C as Client
  participant S1 as Server S1
  participant S2 as Server S2
  C->>C: Build env, encrypt payload, hash(data)=id
  par broadcast
    C->>S1: POST /pool/message
    C->>S2: POST /pool/message
  end
  C->>C: Store locally
```

- Receive & Client Relay (servers → client → other servers)
```mermaid
sequenceDiagram
  participant C as Client
  participant Sx as Origin Server
  participant Sy as Other Server
  C->>Sx: GET /pool/list
  Sx-->>C: messages[]
  C->>C: decrypt/verify/dedupe/store
  C->>Sy: POST /pool/message (relay id,data)
```

### 1.3 Key Algorithms
- Message ID = SHA-256 over encrypted `data` (base64url)
- Dedupe = processed set + Dexie query by (roomId, ts, senderPub)
- Client Relay = re-POST to all enabled servers except origin
- Verify = signature over `${roomId}:${msg}:${ts}`

### 1.4 Performance
- Promise.all parallel I/O for broadcast and polling
- Idempotent writes on server to avoid lock contention
- Dedupe on client and server sides
- TTL cleanup on server to keep pool small

---

## 2. Server Logic and Principles

### 2.1 Architecture
- Node.js + Express REST APIs
- File-based message pool (POOL_DIR)
- Global CORS
- Optional server-to-server fanout via RELAY_PEERS (not required)

### 2.2 Request Flows
```mermaid
flowchart TD
  A[POST /pool/message] --> B{exists?}
  B -- yes --> C[success]
  B -- no --> D[write id.json]
  D --> E[success]
  E --> F{RELAY_PEERS?}
  F -- yes --> G[async fanout]

  I[GET /pool/list] --> J[read *.json]
  J --> K[filter expired/corrupt]
  K --> L[dedupe by id]
  L --> M[return messages]
```

### 2.3 Storage & Management
- id.json files under POOL_DIR
- TTL cleanup
- Idempotent write & /pool/list de-duplication

### 2.4 Security
- Server does not decrypt or verify payload
- CORS enabled for /pool/*
- Size and field validation

---

## 3. Usage Guide

### 3.1 Requirements
- Node.js 18+
- Modern browsers

### 3.2 Install & Run (dev)
```bash
# Frontend (MeshPath)
cd MeshPath
pnpm i
pnpm run dev

# Server
node server.js
```

### 3.3 Env Vars (server)
```env
RELAY_PORT=8765
POOL_DIR=./message_pool
POOL_TTL_MS=86400000
RELAY_PEERS=http://peer.example.com:8766
```

### 3.4 Common Ops
- Add multiple server URLs in UI and enable them
- Create/Join rooms with rpub/rpriv
- Send: broadcast to all
- Receive: poll any reachable server and then client-relay to others

### 3.5 Troubleshooting
- Only part of peers receive:
  - Ensure the sender enabled multiple servers
  - Ensure at least one user bridges multiple servers
  - Ensure ports are reachable and CORS works
- Duplicates:
  - Handled by idempotency and dedupe
- Dev build/HMR glitches:
  - Keep only one dev process and hard refresh

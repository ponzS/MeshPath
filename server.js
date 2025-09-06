import express from "express";
import qr from "qr";
import ip from "ip";
import 'dotenv/config'
import { Server as SocketIOServer } from 'socket.io';
import crypto from 'crypto';
import Turn from 'node-turn';
import { p256 } from '@noble/curves/p256';
import fs from 'fs';
import path from 'path';

/* global process */

const testPort = (port) => {
  return new Promise((resolve, reject) => {
    const server = express().listen(port, () => {
      server.close(() => resolve(true));
    }).on('error', () => resolve(false));
  });
};

// Utilities for UnSEA-compatible verification
function b64urlToUint8(b64url) {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const pad = '==='.slice((b64.length + 3) % 4);
  const s = b64 + pad;
  return new Uint8Array(Buffer.from(s, 'base64'));
}
function jwkToUncompressed(jwk) {
  const [x, y] = (jwk || '').split('.');
  if (!x || !y) throw new Error('Invalid JWK pub format');
  const xb = b64urlToUint8(x);
  const yb = b64urlToUint8(y);
  return new Uint8Array([4, ...xb, ...yb]);
}
function normalize(s) {
  return (typeof s === 'string' ? s : '').normalize('NFC').trim();
}
async function sha256(msg) {
  const data = new TextEncoder().encode(normalize(msg));
  if (crypto.webcrypto?.subtle) {
    const digest = await crypto.webcrypto.subtle.digest('SHA-256', data);
    return new Uint8Array(digest);
  } else {
    return new Uint8Array(crypto.createHash('sha256').update(data).digest());
  }
}
async function verifyUnseaSignature(message, signatureB64u, pubJwk) {
  try {
    const hash = await sha256(message);
    const pub = jwkToUncompressed(pubJwk);
    const sig = b64urlToUint8(signatureB64u);
    return p256.verify(sig, hash, pub);
  } catch (e) {
    return false;
  }
}

export default {
  initiated: false,
  async init(config = {}) {
    if (this.initiated) return;
    this.initiated = true;

    let {
      host = process.env.RELAY_HOST || ip.address(),
      store = process.env.RELAY_STORE || true,
      port = process.env.RELAY_PORT || 8765,
      path: publicDir = process.env.RELAY_PATH || "public",
      showQr = process.env.RELAY_QR || true
    } = config;

    console.clear();
 

    if (typeof process !== 'undefined' && process && process.env) {
      if (!('MULTICAST' in process.env)) process.env.MULTICAST = 'false';
    }

    var app = express();

    // Global CORS for REST endpoints (esp. /pool/*) to allow frontend dev server cross-origin access
    app.use((req, res, next) => {
      res.header('Access-Control-Allow-Origin', '*');
      res.header('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS');
      res.header('Access-Control-Allow-Headers', 'Content-Type');
      if (req.method === 'OPTIONS') return res.sendStatus(200);
      next();
    });

    // Explicit root route handling
    app.get('/', (req, res) => {
      res.sendFile('index.html', { root: publicDir });
    });

    app.use(express.static(publicDir));

    // Build ICE servers from env
    function buildIceServers() {
      const iceServers = [];
      const enableLocalTurn = (process.env.TURN_ENABLE !== 'false' && process.env.STUN_TURN_ENABLE !== 'false');
      const preferLocal = (process.env.PREFER_LOCAL_TURN !== 'false'); // default: true

      // Prepare local embedded entries
      const localEntries = [];
      const turnUsername = process.env.TURN_USERNAME || process.env.TURN_USER || '';
      const turnCredential = process.env.TURN_CREDENTIAL || process.env.TURN_PASS || '';
      const hostForUrls = process.env.TURN_PUBLIC_IP || host;
      const udpPort = Number(process.env.TURN_PORT || process.env.TURN_UDP_PORT || 8765);
      const tcpPort = Number(process.env.TURN_TCP_PORT || 0);
      if (enableLocalTurn) {
        localEntries.push({ urls: [`stun:${hostForUrls}:${udpPort}`] });
        if (turnUsername && turnCredential) {
          const urls = [`turn:${hostForUrls}:${udpPort}?transport=udp`];
          if (tcpPort) urls.push(`turn:${hostForUrls}:${tcpPort}?transport=tcp`);
          localEntries.push({ urls, username: turnUsername, credential: turnCredential });
        }
      }

      // Priority 1: ICE_SERVERS as JSON
      try {
        if (process.env.ICE_SERVERS) {
          const parsed = JSON.parse(process.env.ICE_SERVERS);
          const parsedList = Array.isArray(parsed) ? parsed : (parsed && Array.isArray(parsed.iceServers) ? parsed.iceServers : []);
          if (parsedList.length) {
            return preferLocal ? [...localEntries, ...parsedList] : [...parsedList, ...localEntries];
          }
        }
      } catch(e) { /* ignore parse error */ }

      // Priority 2: STUN_URLS and TURN_URLS (comma separated)
      const envEntries = [];
      const stunUrls = (process.env.STUN_URLS || '').split(',').map(s=>s.trim()).filter(Boolean);
      if (stunUrls.length) envEntries.push({ urls: stunUrls });

      const turnUrls = (process.env.TURN_URLS || '').split(',').map(s=>s.trim()).filter(Boolean);
      if (turnUrls.length) {
        const turnEntry = { urls: turnUrls };
        if (turnUsername) turnEntry.username = turnUsername;
        if (turnCredential) turnEntry.credential = turnCredential;
        envEntries.push(turnEntry);
      }

      const merged = preferLocal ? [...localEntries, ...envEntries] : [...envEntries, ...localEntries];
      if (merged.length) return merged;

      // Final fallback: Google STUN
      return [{ urls: ['stun:stun.l.google.com:19302'] }];
    }

    // Expose /ice endpoint for clients to fetch dynamic ICE config
    app.get('/ice', (req, res) => {
      const iceServers = buildIceServers();
      // Provide signaling origins to ease local development
      const localOrigin = `http://localhost:${port}`;
      const currentOrigin = (() => {
        const hostHdr = req.headers.host || `${host}${port ? ':'+port : ''}`;
        const proto = (req.headers['x-forwarded-proto'] || req.protocol || 'http').toString();
        return `${proto}://${hostHdr}`;
      })();
      res.json({ iceServers, signaling: { currentOrigin, localOrigin } });
    });

    let currentPort = parseInt(port);
    while (!(await testPort(currentPort))) {
      console.log(`Port ${currentPort} in use, trying next...`);
      currentPort++;
    }

    var server = app.listen(currentPort);
    port = currentPort; // Update port for later use

    // Initialize embedded STUN/TURN (UDP on same numeric port by default 3478)
    const enableLocalTurn = (process.env.TURN_ENABLE !== 'false' && process.env.STUN_TURN_ENABLE !== 'false');
    if (enableLocalTurn) {
      const turnUdpPort = Number(process.env.TURN_PORT || process.env.TURN_UDP_PORT || 8765);
      if (turnUdpPort === Number(port)) {
        console.warn('[TURN] WARNING: TURN UDP port equals HTTP port.');
      }
      const listeningIps = (process.env.TURN_LISTEN_IPS || '').split(',').map(s=>s.trim()).filter(Boolean);
      const realm = process.env.TURN_REALM || host;
      const minPort = Number(process.env.TURN_MIN_PORT || 49160);
      const maxPort = Number(process.env.TURN_MAX_PORT || 49200);
      const username = process.env.TURN_USERNAME || process.env.TURN_USER;
      const password = process.env.TURN_CREDENTIAL || process.env.TURN_PASS;
      const credentials = (username && password) ? { [username]: password } : {};

      try {
        const turnServer = new Turn({
          listeningPort: turnUdpPort,
          listeningIps: listeningIps.length ? listeningIps : ['0.0.0.0'],
          minPort,
          maxPort,
          realm,
          authMech: Object.keys(credentials).length ? 'long-term' : undefined,
          credentials
        });
        turnServer.start();
        console.log(`[TURN] Embedded STUN/TURN started on udp://${host}:${turnUdpPort} (realm: ${realm})`);
        if (Object.keys(credentials).length === 0) {
          console.log('[TURN] No TURN credentials configured; providing STUN only via /ice by default');
        }
      } catch (e) {
        console.warn('[TURN] Failed to start embedded STUN/TURN:', e?.message || e);
      }
    } else {
      console.log('[TURN] Embedded STUN/TURN disabled by env (TURN_ENABLE/STUN_TURN_ENABLE=false)');
    }

    // Initialize Socket.IO for signaling relay
    const io = new SocketIOServer(server, {
      cors: { origin: '*' },
      path: '/socket.io'
    });

    const link = "http://" + host + (port ? ":" + port : "");
    // Make external link protocol configurable; default to http for local/LAN testing
    const extProto = (process.env.RELAY_HTTPS === 'true' || process.env.FORCE_HTTPS === 'true') ? 'https://' : 'http://';
    const extLink = extProto + host + (port ? ":" + port : "");

    console.log(`Internal URL: ${link}/`);
    console.log(`External URL: ${extLink}/`);
    console.log(`Localhost URL: http://localhost:${port}/`);
    console.log(`ICE endpoint: http://localhost:${port}/ice`);
    console.log(`Socket.IO path: http://localhost:${port}/socket.io`);

    if (showQr != false) {
      console.log('\n=== QR CODE ===');
      console.log(qr(link, 'ascii', { border: 1 }))
      console.log('===============\n');
    }

    // ==============================
    // Message Pool API for Mesh Network Chat
    // ==============================
    const POOL_DIR = process.env.POOL_DIR || './message_pool';
    const POOL_TTL = Number(process.env.POOL_TTL || 86400000); // 1 day in ms

    // Ensure pool directory exists
    if (!fs.existsSync(POOL_DIR)) {
      fs.mkdirSync(POOL_DIR, { recursive: true });
    }

    // Cleanup expired messages on startup and periodically
    function cleanupExpiredMessages() {
      try {
        const files = fs.readdirSync(POOL_DIR);
        const now = Date.now();
        let cleaned = 0;
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(POOL_DIR, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtime.getTime() > POOL_TTL) {
              fs.unlinkSync(filePath);
              cleaned++;
            }
          } catch (e) {
            // File might be deleted by another process, ignore
          }
        }
        if (cleaned > 0) {
          console.log(`[POOL] Cleaned ${cleaned} expired messages`);
        }
      } catch (e) {
        console.warn('[POOL] Cleanup error:', e?.message || e);
      }
    }

    cleanupExpiredMessages();
    setInterval(cleanupExpiredMessages, 3600000); // Clean every hour

    // POST /pool/message - Store encrypted message
    app.post('/pool/message', express.json({ limit: '10mb' }), (req, res) => {
      try {
        const { id, data, signature } = req.body;
        if (!id || !data || typeof id !== 'string' || typeof data !== 'string') {
          return res.status(400).json({ error: 'Invalid message format' });
        }
        
        // Basic validation
        if (id.length > 128 || data.length > 1024 * 1024) {
          return res.status(400).json({ error: 'Message too large' });
        }

        const messageFile = path.join(POOL_DIR, `${id}.json`);

        // Idempotent write: if exists, return success directly
        if (fs.existsSync(messageFile)) {
          return res.json({ success: true, id, dedup: true });
        }

        const messageData = {
          id,
          data,
          signature: signature || '',
          timestamp: Date.now(),
          ip: req.ip || req.connection?.remoteAddress || 'unknown'
        };

        fs.writeFileSync(messageFile, JSON.stringify(messageData));

        // Server-to-server fanout (best-effort, fire-and-forget)
        try {
          const peers = String(process.env.RELAY_PEERS || '')
            .split(',')
            .map(s => s.trim())
            .filter(Boolean);
          for (const peer of peers) {
            const url = `${peer.replace(/\/$/, '')}/pool/message`;
            // no await to avoid blocking response; but small await per peer is acceptable
            fetch(url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ id, data, signature: signature || '' })
            }).catch(() => {});
          }
        } catch (_) {
          // ignore fanout errors
        }

        res.json({ success: true, id });
      } catch (e) {
        console.error('[POOL] Store error:', e);
        res.status(500).json({ error: 'Storage failed' });
      }
    });

    // GET /pool/list - List available messages (for polling)
    app.get('/pool/list', (req, res) => {
      try {
        const files = fs.readdirSync(POOL_DIR);
        const messages = [];
        const now = Date.now();
        
        for (const file of files) {
          if (!file.endsWith('.json')) continue;
          const filePath = path.join(POOL_DIR, file);
          try {
            const stat = fs.statSync(filePath);
            if (now - stat.mtime.getTime() > POOL_TTL) continue; // Skip expired
            
            const content = fs.readFileSync(filePath, 'utf8');
            const messageData = JSON.parse(content);
            messages.push({
              id: messageData.id,
              data: messageData.data,
              signature: messageData.signature,
              timestamp: messageData.timestamp
            });
          } catch (e) {
            // Skip corrupted files
          }
        }
        
        // Deduplicate by id in case of race conditions
        const uniq = new Map();
        for (const m of messages) {
          if (!uniq.has(m.id)) uniq.set(m.id, m);
        }
        
        res.json({ messages: Array.from(uniq.values()) });
      } catch (e) {
        console.error('[POOL] List error:', e);
        res.status(500).json({ error: 'List failed' });
      }
    });

    // DELETE /pool/message/:id - Delete message after successful decryption
    app.delete('/pool/message/:id', (req, res) => {
      try {
        const { id } = req.params;
        if (!id || typeof id !== 'string' || id.length > 128) {
          return res.status(400).json({ error: 'Invalid message ID' });
        }

        const messageFile = path.join(POOL_DIR, `${id}.json`);
        if (fs.existsSync(messageFile)) {
          fs.unlinkSync(messageFile);
          res.json({ success: true });
        } else {
          res.status(404).json({ error: 'Message not found' });
        }
      } catch (e) {
        console.error('[POOL] Delete error:', e);
        res.status(500).json({ error: 'Delete failed' });
      }
    });

    console.log('[POOL] Message pool APIs enabled:');
    console.log(`  POST   ${link}/pool/message`);
    console.log(`  GET    ${link}/pool/list`);
    console.log(`  DELETE ${link}/pool/message/:id`);
    console.log(`  TTL: ${POOL_TTL}ms (${Math.round(POOL_TTL/3600000)}h)`);

    // ==============================
    // Signaling relay with room isolation by publicKey
    // ==============================
    const rooms = new Map(); // roomPubKey => Set(socketId)

    io.of('/').on('connection', (socket) => {
      let authed = false;
      let roomPub = null;

      socket.on('get_challenge', () => {
        const id = crypto.randomUUID();
        const text = `Sign to join room at ${Date.now()}`;
        // Map challengeId -> text stored per-socket via memory Map on socket
        if (!socket.data) socket.data = {};
        if (!socket.data.challenges) socket.data.challenges = new Map();
        socket.data.challenges.set(id, text);
        socket.emit('challenge', { id, text });
      });

      socket.on('auth', async ({ roomPub: rp, signature, challengeId }) => {
        const text = socket.data?.challenges?.get(challengeId);
        if (!text) return socket.emit('auth_error', { message: 'no challenge' });
        socket.data.challenges.delete(challengeId);
        const ok = await verifyUnseaSignature(text, signature, rp);
        if (!ok) return socket.emit('auth_error', { message: 'verify failed' });
        authed = true; roomPub = rp;
        socket.join(roomPub);
        if (!rooms.has(roomPub)) rooms.set(roomPub, new Set());
        const s = rooms.get(roomPub);
        s.add(socket.id);
        const others = Array.from(s).filter(id => id !== socket.id);
        console.log('[auth_ok]', socket.id, 'room', roomPub, 'others', others.length);
        socket.emit('auth_ok', { roomPub, peers: s.size, self: socket.id, others });
        socket.to(roomPub).emit('peer-joined', { id: socket.id });
      });

      socket.on('signal', ({ type, data, to }) => {
        if (!authed) return;
        console.log('[signal]', type, 'from', socket.id, 'to', to);
        socket.to(to).emit('signal', { from: socket.id, type, data });
      });

      // In-room chat: broadcast plaintext or E2EE ciphertext to everyone in the same room
      socket.on('chat', (msg) => {
        if (!authed || !roomPub) return;
        try {
          const base = { from: socket.id };
          // Encrypted form: { ct, iv, ts? }
          if (msg && typeof msg.ct === 'string' && typeof msg.iv === 'string') {
            const ct = msg.ct.slice(0, 8192);
            const iv = msg.iv.slice(0, 128);
            const ts = (typeof msg.ts === 'number' && isFinite(msg.ts)) ? msg.ts : Date.now();
            io.to(roomPub).emit('chat', { ...base, ct, iv, ts });
            return;
          }
          // Plaintext form: { text }
          const t = (typeof msg?.text === 'string' ? msg.text : '').trim();
          if (!t) return;
          const ts = Date.now();
          io.to(roomPub).emit('chat', { ...base, text: t.slice(0, 2000), ts });
        } catch (e) { /* ignore */ }
      });

      socket.on('disconnect', () => {
        if (authed && roomPub) {
          const s = rooms.get(roomPub);
          if (s) {
            s.delete(socket.id);
            socket.to(roomPub).emit('peer-left', { id: socket.id });
            if (s.size === 0) { rooms.delete(roomPub); }
          }
        }
      });
    });

    return { app };
  },
};
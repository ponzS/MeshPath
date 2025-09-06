import { reactive, computed, onMounted, onBeforeUnmount, watch } from 'vue'
import * as unsea from 'unsea'
import { db, type TextRoom, type TextMessage } from './db'
import { useUser } from './useUser'

interface PoolMessage {
  id: string
  data: string
  signature?: string
  timestamp?: number
}

interface RoomEnvelope {
  t: 'mesh:text'
  roomId: string
  msg: string
  fromPub: string
  ts: number
  sig?: string
}

interface RoomWrappedPayload {
  scheme: 'room'
  roomId: string
  rpub: string
  payload: any // encryptMessageWithMeta result
}

// Simple base64url util
function bufToB64Url(buf: ArrayBuffer | Uint8Array) {
  const u8 = buf instanceof Uint8Array ? buf : new Uint8Array(buf)
  let bin = ''
  for (let i = 0; i < u8.length; i++) bin += String.fromCharCode(u8[i])
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

async function sha256b64url(s: string) {
  const enc = new TextEncoder()
  const buf = enc.encode(s)
  const hash = await crypto.subtle.digest('SHA-256', buf)
  return bufToB64Url(hash)
}

let __meshSingleton: any = null

export function useMeshChat() {
  if (__meshSingleton) return __meshSingleton

  const user = useUser()

  const state = reactive({
    rooms: [] as TextRoom[],
    messagesMap: {} as Record<string, TextMessage[]>,
    currentRoomId: '' as string,
    newRoomName: '',
    joinInput: '',
    sending: false,
    polling: false,
    lastPollAt: 0,
  })

  const currentRoom = computed(() => state.rooms.find(r => r.id === state.currentRoomId) || null)
  const currentMessages = computed(() => state.messagesMap[state.currentRoomId] || [])

  async function loadRooms() {
    state.rooms = await db.textRooms.toArray()
  }

  async function loadMessages(roomId: string) {
    const items = await db.textMessages.where({ roomId }).sortBy('ts')
    state.messagesMap[roomId] = items
  }

  function selectRoom(id: string) {
    state.currentRoomId = id
    loadMessages(id)
  }

  async function createTextRoom() {
    const name = state.newRoomName.trim() || '未命名文本房间'
    const pair = await user.crypto.generatePair()
    const rpub = String(pair.epub)
    const rpriv = String(pair.epriv)
    const now = Date.now()
    const id = rpub // 使用 rpub 作为唯一ID
    const exists = await db.textRooms.get(id)
    if (exists) {
      // 极低概率，直接更新时间与名称
      await db.textRooms.update(id, { name, updatedAt: now })
    } else {
      await db.textRooms.add({ id, ownerUserId: user.currentUser!.id, name, rpub, rpriv, createdAt: now, updatedAt: now })
    }
    await loadRooms()
    state.newRoomName = ''
  }

  async function joinTextRoomByJSON() {
    let json: any
    try {
      json = JSON.parse(state.joinInput)
    } catch (e) {
      alert('加入失败：请粘贴包含 rpub/rpriv 的 JSON')
      return
    }
    if (!json || !json.rpub || !json.rpriv) {
      alert('加入失败：缺少 rpub/rpriv 字段')
      return
    }
    const now = Date.now()
    const id = String(json.rpub)
    const name = String(json.name || '外部房间')
    const exists = await db.textRooms.get(id)
    if (exists) {
      await db.textRooms.update(id, { name, updatedAt: now })
    } else {
      await db.textRooms.add({ id, ownerUserId: user.currentUser!.id, name, rpub: String(json.rpub), rpriv: String(json.rpriv), createdAt: now, updatedAt: now })
    }
    await loadRooms()
    state.joinInput = ''
  }

  async function sendTextMessage() {
    const room = currentRoom.value
    if (!room) return
    const content = prompt('输入要发送的消息：', '') || ''
    if (!content.trim()) return
    try {
      state.sending = true
      const ts = Date.now()
      const msgToSign = `${room.id}:${content}:${ts}`
      const sig = await user.crypto.sign(msgToSign, user.currentUser!.priv)
      const env: RoomEnvelope = { t: 'mesh:text', roomId: room.id, msg: content, fromPub: user.currentUser!.pub, ts, sig }
      const payload = await unsea.encryptMessageWithMeta(JSON.stringify(env), { epub: room.rpub })
      const wrapper: RoomWrappedPayload = { scheme: 'room', roomId: room.id, rpub: room.rpub, payload }
      const data = JSON.stringify(wrapper)
      const id = await sha256b64url(data)

      // 广播到所有启用的服务端
      await Promise.all(
        (user.servers || []).filter((s: { url: string; enabled: boolean }) => s.enabled).map(async (s: { url: string }) => {
          const url = `${s.url.replace(/\/$/, '')}/pool/message`
          try {
            await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id, data }) })
          } catch (_) {
            // ignore single server errors
          }
        })
      )

      // 本地存储已发送消息
      const item: TextMessage = { roomId: room.id, senderPub: user.currentUser!.pub, content, raw: data, ts }
      const idb = await db.textMessages.add(item)
      item.id = idb
      state.messagesMap[room.id] = [...(state.messagesMap[room.id] || []), item]
      await db.textRooms.update(room.id, { updatedAt: Date.now() })
      await loadRooms()
    } finally {
      state.sending = false
    }
  }

  const processed = new Set<string>()
  let pollTimer: any = null

  async function handleIncoming(m: PoolMessage, serverUrl: string) {
    if (!m || !m.id || !m.data) return
    if (processed.has(m.id)) return
 
    let obj: any
    try {
      obj = JSON.parse(m.data)
    } catch (_) {
      return
    }

    if (obj && obj.scheme === 'room' && obj.payload && obj.rpub) {
      const room = state.rooms.find(r => r.rpub === obj.rpub)
      if (!room) return
      // 尝试解密
      try {
        const plaintext = await unsea.decryptMessageWithMeta(obj.payload, room.rpriv)
        const env: RoomEnvelope = JSON.parse(plaintext)
        if (env.t !== 'mesh:text' || env.roomId !== room.id) return
        // 验证签名
        if (env.sig && env.fromPub) {
          const ok = await user.crypto.verify(`${env.roomId}:${env.msg}:${env.ts}`, env.sig, env.fromPub)
          if (!ok) return
        }
        // 去重：同一房间同一发送者同一时间戳视为同一消息
        let exists = (state.messagesMap[env.roomId] || []).some(x => x.ts === env.ts && x.senderPub === env.fromPub)
        if (!exists) {
          const existingDB = await db.textMessages.where({ roomId: env.roomId }).and(x => x.ts === env.ts && x.senderPub === env.fromPub).first()
          exists = !!existingDB
        }
        if (!exists) {
          // 保存到本地
          const item: TextMessage = { roomId: env.roomId, senderPub: env.fromPub, content: env.msg, raw: m.data, ts: env.ts }
          const idb = await db.textMessages.add(item)
          item.id = idb
          state.messagesMap[env.roomId] = [...(state.messagesMap[env.roomId] || []), item]
          await db.textRooms.update(room.id, { updatedAt: Date.now() })
          await loadRooms()
        }

        // 成功处理后再标记为已处理
        processed.add(m.id)

        // 客户端中继：将收到的消息再转发到其它已启用的服务器（去中心化复制）
        try {
          const servers = (user.servers || []).filter((s: { url: string; enabled: boolean }) => s.enabled)
          await Promise.all(servers.map(async (s: { url: string }) => {
            const u = s.url.replace(/\/$/, '')
            const origin = serverUrl?.replace(/\/$/, '')
            if (origin && u === origin) return
            try {
              await fetch(`${u}/pool/message`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ id: m.id, data: m.data })
              })
            } catch (_) {
              // ignore relay errors per server
            }
          }))
        } catch (_) {
          // ignore relay aggregation errors
        }

        // 回收删除逻辑已移除，交给服务端基于 TTL 定期清理，避免多端未读取时被提前删除
      } catch (_) {
        // 解密失败：忽略或未来可重试（未标记 processed，允许后续再次尝试）
      }
      return
    }
  }

  async function pollOnce() {
    if (state.polling) return
    state.polling = true
    try {
      const servers = (user.servers || []).filter((s: { url: string; enabled: boolean }) => s.enabled)
      await Promise.all(servers.map(async (s: { url: string }) => {
        try {
          const resp = await fetch(`${s.url.replace(/\/$/, '')}/pool/list`)
          if (!resp.ok) return
          const json = await resp.json()
          const messages: PoolMessage[] = Array.isArray(json?.messages) ? json.messages : []
          for (const m of messages) {
            await handleIncoming(m, s.url)
          }
        } catch (_) {
          // ignore
        }
      }))
      state.lastPollAt = Date.now()
    } finally {
      state.polling = false
    }
  }

  function startPolling() {
    stopPolling()
    pollTimer = setInterval(pollOnce, 4000)
  }

  function stopPolling() {
    if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
  }

  onMounted(async () => {
    await loadRooms()
    if (state.rooms[0]?.id) selectRoom(state.rooms[0].id)
    startPolling()
  })

  onBeforeUnmount(() => {
    stopPolling()
  })

  watch(() => user.servers.map((s: { url: string; enabled: boolean }) => `${s.url}:${s.enabled}`).join(','), () => {
    // 服务器列表变更后立即触发一次轮询
    pollOnce()
  })

  __meshSingleton = state
  Object.assign(__meshSingleton, {
    currentRoom,
    currentMessages,
    loadRooms,
    loadMessages,
    selectRoom,
    createTextRoom,
    joinTextRoomByJSON,
    sendTextMessage,
    pollOnce,
  })

  return __meshSingleton
}
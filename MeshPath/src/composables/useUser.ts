import { reactive, computed, onMounted } from 'vue'
import * as unsea from 'unsea'
import { db, LS_CURRENT_USER, type User } from './db'

export interface LoginResult {
  ok: boolean
  message?: string
}

// 网状聊天服务端连接
export interface MeshServer {
  url: string
  enabled: boolean
  lastStatus?: 'ok' | 'error' | 'unknown'
  lastSyncAt?: number
}

export const LS_MESH_SERVERS = 'mesh_servers_v1'

let __userSingleton: any = null

export function useUser() {
  if (__userSingleton) return __userSingleton

  const state = reactive({
    currentUser: null as User | null,
    loading: false,

    // forms
    loginPairText: '',
    registerNickname: '',

    // 网状聊天：服务端列表
    servers: [] as MeshServer[],
  })

  const isAuthed = computed(() => !!state.currentUser)

  async function loadFromStorage() {
    try {
      const id = localStorage.getItem(LS_CURRENT_USER)
      if (!id) return
      const u = await db.users.get(id)
      if (u) {
        state.currentUser = u
        await db.users.update(u.id, { lastLoginAt: Date.now() })
      }
    } catch (_) {
      // ignore
    }
  }

  function loadServersFromStorage() {
    try {
      const raw = localStorage.getItem(LS_MESH_SERVERS)
      if (!raw) return
      const arr = JSON.parse(raw)
      if (Array.isArray(arr)) {
        state.servers = arr.filter(Boolean)
      }
    } catch (_) {
      // ignore
    }
  }

  function saveServersToStorage() {
    try {
      localStorage.setItem(LS_MESH_SERVERS, JSON.stringify(state.servers))
    } catch (_) {
      // ignore
    }
  }

  function normalizeUrl(url: string) {
    const s = String(url || '').trim()
    if (!s) return ''
    if (!/^https?:\/\//i.test(s)) return `http://${s}`
    return s
  }

  function addServer(url: string) {
    const u = normalizeUrl(url)
    if (!u) return
    const exists = state.servers.some(s => s.url === u)
    if (exists) return
    state.servers.push({ url: u, enabled: true, lastStatus: 'unknown' })
    saveServersToStorage()
  }

  function removeServer(url: string) {
    const u = normalizeUrl(url)
    const idx = state.servers.findIndex(s => s.url === u)
    if (idx >= 0) {
      state.servers.splice(idx, 1)
      saveServersToStorage()
    }
  }

  function setServerEnabled(url: string, enabled: boolean) {
    const u = normalizeUrl(url)
    const item = state.servers.find(s => s.url === u)
    if (item) {
      item.enabled = !!enabled
      saveServersToStorage()
    }
  }

  async function pingServer(url: string) {
    const u = normalizeUrl(url)
    const item = state.servers.find(s => s.url === u)
    try {
      const resp = await fetch(`${u.replace(/\/$/, '')}/pool/list`, { method: 'GET' })
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      item && (item.lastStatus = 'ok', item.lastSyncAt = Date.now())
      return true
    } catch (_) {
      item && (item.lastStatus = 'error')
      return false
    } finally {
      saveServersToStorage()
    }
  }

  // 加解密/签名工具封装
  async function sign(msg: string, privB64: string) {
    return unsea.signMessage(msg, privB64)
  }
  async function verify(msg: string, sigB64: string, pubJwk: string) {
    return unsea.verifyMessage(msg, sigB64, pubJwk)
  }
  // 兼容封装：使用 encryptMessageWithMeta/decryptMessageWithMeta
  // 注意：encryptMessageWithMeta 仅需接收方的 epub，会自动携带必要的元信息；
  // 这里保留 senderEpriv/senderEpub 形参以保持 API 兼容，但不会使用。
  async function encryptForRecipient(msg: string, _senderEpriv: string, receiverEpub: string) {
    return unsea.encryptMessageWithMeta(msg, { epub: receiverEpub })
  }
  async function decryptFromSender(payload: any, _senderEpub: string, receiverEpriv: string) {
    return unsea.decryptMessageWithMeta(payload, receiverEpriv)
  }
  async function generatePair() {
    return unsea.generateRandomPair()
  }

  async function loginWithPair(pairText: string): Promise<LoginResult> {
    try {
      state.loading = true
      let json: any
      try {
        json = JSON.parse(pairText)
      } catch (_) {
        return { ok: false, message: '密钥对格式错误，请粘贴包含 pub/priv 的 JSON' }
      }
      if (!json || !json.pub || !json.priv) {
        return { ok: false, message: '缺少 pub/priv 字段' }
      }
      const id = String(json.pub)
      const u = await db.users.get(id)
      if (!u) {
        return { ok: false, message: '该密钥对未注册，请先注册或使用已注册密钥' }
      }
      // 更新私钥（允许用户替换为同 pub 的新 priv）
      await db.users.update(id, { priv: String(json.priv), lastLoginAt: Date.now() })
      const updated = await db.users.get(id)
      state.currentUser = updated || u
      localStorage.setItem(LS_CURRENT_USER, id)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e) }
    } finally {
      state.loading = false
    }
  }

  async function registerNew(nickname: string): Promise<LoginResult> {
    try {
      state.loading = true
      const pair = await unsea.generateRandomPair()
      const id = String(pair.pub)
      const exists = await db.users.get(id)
      if (exists) {
        // 极少数情况下随机碰撞，重试一次
        const pair2 = await unsea.generateRandomPair()
        const id2 = String(pair2.pub)
        await db.users.add({
          id: id2,
          pub: String(pair2.pub),
          priv: String(pair2.priv || ''),
          nickname: nickname || '未命名',
          createdAt: Date.now(),
          lastLoginAt: Date.now(),
        })
        const u2 = await db.users.get(id2)
        state.currentUser = u2 || null
        localStorage.setItem(LS_CURRENT_USER, id2)
        return { ok: true }
      }
      await db.users.add({
        id,
        pub: String(pair.pub),
        priv: String(pair.priv || ''),
        nickname: nickname || '未命名',
        createdAt: Date.now(),
        lastLoginAt: Date.now(),
      })
      const u = await db.users.get(id)
      state.currentUser = u || null
      localStorage.setItem(LS_CURRENT_USER, id)
      return { ok: true }
    } catch (e: any) {
      return { ok: false, message: e?.message || String(e) }
    } finally {
      state.loading = false
    }
  }

  function logout() {
    try { localStorage.removeItem(LS_CURRENT_USER) } catch (_) {}
    state.currentUser = null
  }

  onMounted(() => {
    loadFromStorage()
    loadServersFromStorage()
  })

  // 返回响应式的单例对象：将方法与计算属性挂到 reactive 的 state 上，避免解构导致的非响应式副作用
  __userSingleton = state
  Object.assign(__userSingleton, {
    isAuthed,
    loadFromStorage,
    loginWithPair,
    registerNew,
    logout,
    // servers
    loadServersFromStorage,
    saveServersToStorage,
    addServer,
    removeServer,
    setServerEnabled,
    pingServer,
    // crypto helpers
    crypto: {
      sign,
      verify,
      encryptForRecipient,
      decryptFromSender,
      generatePair,
    }
  })

  return __userSingleton
}
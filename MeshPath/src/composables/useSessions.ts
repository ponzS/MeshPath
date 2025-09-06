import { reactive, computed, watch, onMounted } from 'vue'
import { db, type Room, type Message, type MemberEvent } from './db'
import { useUser } from './useUser'
import * as unsea from 'unsea'

export interface JoinParseResult {
  ok: boolean
  message?: string
}

export function useSessions() {
  const user = useUser()
  const state = reactive({
    rooms: [] as Room[],
    messagesMap: {} as Record<string, Message[]>,
    currentRoomId: '',

    // top actions
    createRoomName: '',
    createRoomSignaling: 'http://localhost:8765',
    joinInput: '',

    // members cache
    membersMap: {} as Record<string, { userId: string; nickname: string }[]>,
  })

  const currentRoom = computed(() => state.rooms.find(r => r.id === state.currentRoomId) || null)
  const currentMessages = computed(() => state.currentRoomId ? (state.messagesMap[state.currentRoomId] || []) : [])

  async function loadRooms() {
    if (!user.currentUser) return
    const list = await db.rooms.where('userId').equals(user.currentUser.id).reverse().sortBy('updatedAt')
    state.rooms = list
    if (!state.currentRoomId && state.rooms.length) state.currentRoomId = state.rooms[0].id
    await loadMessagesFor(state.currentRoomId)
    await loadMembersFor(state.currentRoomId)
  }

  async function loadMessagesFor(roomId: string) {
    if (!roomId) return
    const msgs = await db.messages.where('roomId').equals(roomId).reverse().sortBy('ts')
    state.messagesMap[roomId] = msgs
  }

  async function loadMembersFor(roomId: string) {
    if (!roomId) return
    const events = await db.memberEvents.where('roomId').equals(roomId).sortBy('ts')
    const set = new Map<string, { userId: string; nickname: string }>()
    for (const ev of events) {
      if (ev.eventType === 'join') set.set(ev.userId, { userId: ev.userId, nickname: ev.nickname })
      else if (ev.eventType === 'leave') set.delete(ev.userId)
    }
    state.membersMap[roomId] = Array.from(set.values())
  }

  async function appendMemberEvent(ev: MemberEvent) {
    await db.memberEvents.add(ev)
    await loadMembersFor(ev.roomId)
  }

  function getCurrentMembers(roomId: string) {
    return state.membersMap[roomId] || []
  }

  async function createRoom() {
    if (!user.currentUser) return
    const id = crypto.randomUUID()
    // 使用 unsea 生成密钥对
    const pair = await unsea.generateRandomPair()
    // 加密/解密自检，确保密钥可用
    try {
      const enc = await unsea.encryptMessageWithMeta('ping', pair)
      const dec = await unsea.decryptMessageWithMeta(enc, pair.epriv)
      const plain = typeof dec === 'string' ? dec : (dec && (dec.message || dec.text || dec.plain))
      if (plain !== 'ping') throw new Error('解密结果不一致')
    } catch (e: any) {
      return alert('密钥对加解密自检失败：' + (e?.message || e))
    }
    const pairText = JSON.stringify(pair)
    const room: Room = {
      id,
      userId: user.currentUser.id,
      name: state.createRoomName || '未命名房间',
      pairText,
      manualSignalingEnabled: !!state.createRoomSignaling,
      manualSignalingUrl: state.createRoomSignaling || '',
      updatedAt: Date.now(),
    }
    await db.rooms.add(room)
    state.rooms.unshift(room)
    state.currentRoomId = id
    state.createRoomName = ''
    // 记录自己加入
    await appendMemberEvent({ roomId: id, userId: user.currentUser.id, nickname: user.currentUser.nickname, eventType: 'join', ts: Date.now() })
  }

  function parseShareLink(input: string) {
    input = (input || '').trim()
    if (!input) return null
    try {
      if (input.startsWith('{')) {
        const json = JSON.parse(input)
        if (json && json.pair && json.signaling) return json
      }
    } catch (_) { /* ignore */ }
    try {
      const url = new URL(input)
      const pair = url.searchParams.get('pair')
      const sig = url.searchParams.get('signaling')
      const name = url.searchParams.get('name') || ''
      if (pair) {
        const pairJson = JSON.parse(decodeURIComponent(pair))
        return { pair: pairJson, signaling: sig || '', name }
      }
    } catch (_) { /* ignore */ }
    try {
      const json = JSON.parse(input)
      if (json && json.pub) {
        return { pair: json, signaling: '', name: '' }
      }
    } catch (_) {}
    return null
  }

  async function joinByShare(input: string): Promise<JoinParseResult> {
    const parsed = parseShareLink(input)
    if (!parsed) return { ok: false, message: '无法解析分享内容' }
    if (!user.currentUser) return { ok: false, message: '未登录' }

    // 如果分享包含完整密钥（含 priv 与 epriv），进行一次加解密自检
    try {
      const p: any = parsed.pair || {}
      if (p && p.priv && p.epriv) {
        const enc = await unsea.encryptMessageWithMeta('ping', p)
        const dec = await unsea.decryptMessageWithMeta(enc, p.epriv)
        const plain = typeof dec === 'string' ? dec : (dec && (dec.message || dec.text || dec.plain))
        if (plain !== 'ping') throw new Error('解密结果不一致')
      }
    } catch (e: any) {
      return { ok: false, message: '密钥对加解密自检失败：' + (e?.message || e) }
    }

    const id = crypto.randomUUID()
    const room: Room = {
      id,
      userId: user.currentUser.id,
      name: parsed.name || '新加入的房间',
      pairText: JSON.stringify(parsed.pair),
      manualSignalingEnabled: !!parsed.signaling,
      manualSignalingUrl: parsed.signaling || '',
      updatedAt: Date.now(),
    }
    await db.rooms.add(room)
    state.rooms.unshift(room)
    state.currentRoomId = id
    state.joinInput = ''

    // 记录自己加入
    await appendMemberEvent({ roomId: id, userId: user.currentUser.id, nickname: user.currentUser.nickname, eventType: 'join', ts: Date.now() })

    return { ok: true }
  }

  async function appendMessage(roomId: string, msg: Message) {
    await db.messages.add(msg)
    if (!state.messagesMap[roomId]) state.messagesMap[roomId] = []
    state.messagesMap[roomId].push(msg)
  }

  async function deleteRoom(roomId: string) {
    if (!user.currentUser) return
    try {
      // 删除该房间的消息
      await db.messages.where('roomId').equals(roomId).delete()
    } catch (_) {
      // ignore
    }
    try {
      // 删除房间本身
      await db.rooms.delete(roomId)
    } catch (_) {
      // ignore
    }
    // 记录自己离开
    try {
      await appendMemberEvent({ roomId, userId: user.currentUser.id, nickname: user.currentUser.nickname, eventType: 'leave', ts: Date.now() })
      // 系统通知
      await appendMessage(roomId, { roomId, userIdFrom: 'system', content: `${user.currentUser.nickname} 退出了房间`, ts: Date.now() })
    } catch (_) {}

    // 本地状态更新
    state.rooms = state.rooms.filter(r => r.id !== roomId)
    if (state.currentRoomId === roomId) {
      state.currentRoomId = state.rooms.length ? state.rooms[0].id : ''
    }
    delete state.messagesMap[roomId]
    delete state.membersMap[roomId]
  }

  watch(() => user.currentUser, async (u) => {
    if (u) await loadRooms()
    else {
      state.rooms = []
      state.currentRoomId = ''
      state.messagesMap = {}
    }
  }, { immediate: true })

  onMounted(() => {
    if (user.currentUser) loadRooms()
  })

  // 返回响应式对象：把方法与计算属性挂到 reactive 的 state 上，避免 ...state 打断响应式
  return Object.assign(state, {
    currentRoom,
    currentMessages,
    loadRooms,
    loadMessagesFor,
    // 新增导出：成员方法
    loadMembersFor,
    getCurrentMembers,
    appendMemberEvent,
    createRoom,
    joinByShare,
    appendMessage,
    deleteRoom,
    parseShareLink,
  })
}
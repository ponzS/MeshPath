<template>
  <div class="page">

    <!-- Lang toggle -->
    <div class="row right mb-8">
      <button class="btn" @click="toggleLang">{{ isZh ? 'EN' : '中文' }}</button>
    </div>

    <!-- 上半：视频九宫格（动态行列） -->
    <section class="card video-area">
      <div class="video-grid" :style="videoGridStyle">
        <div class="video-cell" v-for="vid in displayedVideoIds" :key="vid">
          <video v-if="vid === 'local'" id="localVideo" autoplay muted playsinline></video>
          <video v-else :id="`remote-${vid}`" autoplay playsinline></video>
          <div class="video-label">{{ labelForVideo(vid) }}</div>
        </div>
      </div>
    </section>

    <!-- 下半：工具栏 -->
    <section class="card tools-area">
      <!-- 控制条 -->
      <div class="row gap space-between">
        <div class="row gap">
          <button class="btn btn-primary" @click="handleStart" :disabled="startDisabled">{{ isZh ? '开始' : 'Start' }}</button>
          <button class="btn btn-outline" @click="handleStop">{{ isZh ? '停止' : 'Stop' }}</button>
        </div>
        <div class="row gap center">
          <span class="row center">
            <span :class="['dot', connected ? 'green' : 'gray']"></span>
            {{ connected ? (isZh ? '已连接' : 'Connected') : (isZh ? '未连接' : 'Disconnected') }}
          </span>
          <span>• {{ isZh ? '远端' : 'Peers' }}：{{ remotePeers.length }}</span>
        </div>
      </div>

      <!-- 新增：成员列表 -->
      <div class="mt-12">
        <h3 class="h3">{{ isZh ? '成员' : 'Members' }}</h3>
        <div class="memberbox">
          <div v-if="currentMembers.length === 0" class="muted small">{{ isZh ? '暂无成员' : 'No members' }}</div>
          <div v-else class="memberlist">
            <div class="memberline" v-for="m in currentMembers" :key="m.userId">
              <span class="dot green"></span>
              <span class="ml-4">{{ m.nickname }}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- 设备选择 -->
      <div class="grid-2 mt-12">
        <div>
          <label class="label">{{ isZh ? '麦克风' : 'Microphone' }}</label>
          <select v-model="state.selectedAudioIn" class="select">
            <option v-for="d in devices.audioIn" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
          </select>
          <label class="label-inline">
            <input type="checkbox" v-model="state.enableMic" />
            <span>{{ isZh ? '启用麦克风' : 'Enable microphone' }}</span>
          </label>
        </div>
        <div>
          <label class="label">{{ isZh ? '摄像头' : 'Camera' }}</label>
          <select v-model="state.selectedVideoIn" class="select">
            <option v-for="d in devices.videoIn" :key="d.deviceId" :value="d.deviceId">{{ d.label || d.deviceId }}</option>
          </select>
          <label class="label-inline">
            <input type="checkbox" v-model="state.enableCam" />
            <span>{{ isZh ? '启用摄像头' : 'Enable camera' }}</span>
          </label>
        </div>
      </div>

      <!-- 房间密钥与信令 -->
      <div class="grid-2 mt-12">
        <div>
          <label class="label">{{ isZh ? '房间密钥' : 'Room key' }}</label>
          <textarea v-model="state.pairText" @change="loadPair" class="textarea" placeholder='{"pub":"...","priv":"..."}'></textarea>
          <div class="row gap mt-8">
            <button class="btn btn-outline" @click="generatePair">{{ isZh ? '生成密钥对' : 'Generate pair' }}</button>
            <label class="label-inline">
              <input type="checkbox" v-model="state.enableE2EE" />
              <span>{{ isZh ? '媒体端到端加密' : 'Media E2EE' }}</span>
            </label>
            <button class="btn" @click="copyShareLink">{{ isZh ? '复制分享链接' : 'Copy share link' }}</button>
          </div>

          <!-- 分享：二维码 + 链接 -->
          <div class="share-block mt-8">
            <h3 class="h3">{{ isZh ? '分享' : 'Share' }}</h3>
            <p class="small muted">{{ isZh ? `二维码与链接包含房间密钥对${shareData.signaling ? '与信令地址' : ''}。` : `QR & link include room key pair${shareData.signaling ? ' and signaling URL' : ''}.` }}</p>
            <div class="row gap">
              <div class="qrbox">
                <div v-if="shareQrSvg" v-html="shareQrSvg"></div>
                <div v-else class="muted small">{{ isZh ? '暂无二维码' : 'No QR yet' }}</div>
              </div>
              <div class="flex1">
                <input class="input" :value="shareUrl" readonly />
                <div class="row gap right mt-8">
                  <button class="btn" @click="copyShareLink">{{ isZh ? '复制分享链接' : 'Copy share link' }}</button>
                </div>
              </div>
            </div>
          </div>
        </div>
        <div>
          <label class="label">{{ isZh ? '信令' : 'Signaling' }}</label>
          <label class="label-inline">
            <input type="checkbox" v-model="state.manualSignalingEnabled" />
            <span>{{ isZh ? '使用手动信令' : 'Use manual signaling' }}</span>
          </label>
          <div class="row gap mt-8">
            <input type="text" class="input flex1" v-model="state.manualSignalingUrl" :placeholder="isZh ? '手动信令地址（如 http://localhost:8765）' : 'Manual signaling URL (e.g. http://localhost:8765)'" />
            <button class="btn btn-outline" @click="saveManualSignaling">{{ isZh ? '应用' : 'Apply' }}</button>
          </div>
          <div class="muted small mt-4">{{ isZh ? '当前信令：' : 'Current signaling: ' }}{{ displayedSignaling }}</div>
        </div>
      </div>

      <!-- 聊天与日志 -->
      <div class="grid-2 mt-12">
        <div>
          <h3 class="h3">{{ isZh ? '聊天' : 'Chat' }}</h3>
          <div class="chatbox">
            <div v-for="m in chatMessages" :key="m.ts + '-' + m.from" class="chatline">
              <span class="muted small">[{{ new Date(m.ts).toLocaleTimeString() }}] {{ m.from }}:</span>
              <span class="ml-4">{{ m.text }}</span>
            </div>
          </div>
          <div class="row gap mt-8">
            <input class="input flex1" type="text" v-model="state.chatInput" @keyup.enter="sendChatOnEnter" :placeholder="isZh ? '输入消息...' : 'Type a message...'" />
            <button class="btn btn-primary" @click="sendChat">{{ isZh ? '发送' : 'Send' }}</button>
          </div>
          <label class="label-inline mt-8">
            <input type="checkbox" v-model="state.enableChatE2EE" />
            <span>{{ isZh ? '聊天端到端加密' : 'Chat E2EE' }}</span>
          </label>
        </div>
        <div>
          <h3 class="h3">{{ isZh ? '日志' : 'Logs' }}</h3>
          <div class="logbox">
            <div v-for="l in log" :key="l.t + '-' + l.m" class="logline">[{{ l.t }}] {{ l.m }}</div>
          </div>
        </div>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, toRefs, watch, onMounted, ref } from 'vue'
import { useGroup } from '@/composables/useGroup'
import { useRoute } from 'vue-router'
import { useSessions } from '@/composables/useSessions'
import { useUser } from '@/composables/useUser'
import { db } from '@/composables/db'
import type { Room } from '@/composables/db'
import qrcodeSvg from '@qrcode/svg'
import { useLang } from '@/composables/useLang'

const { isZh, toggle } = useLang()
const toggleLang = () => toggle()

// 单房间通话/媒体逻辑
const state = useGroup()
const {
  pairText,
  devices,
  selectedAudioIn,
  selectedVideoIn,
  enableMic,
  enableCam,
  enableE2EE,
  connected,
  remotePeers,
  manualSignalingEnabled,
  manualSignalingUrl,
  signalingOrigin,
  chatMessages,
  chatInput,
  enableChatE2EE,
  log,
} = toRefs(state)
const { generatePair, loadPair, start, stop, saveManualSignaling, sendChat, sendChatOnEnter } = state

// 会话与成员
const sessions = useSessions()
const currentMembers = computed(() => sessions.getCurrentMembers(sessions.currentRoomId))
sessionWatch()
const peerNicknameMap = computed<Record<string, string>>(() => {
  const map: Record<string, string> = {}
  for (const m of currentMembers.value) map[m.userId] = m.nickname
  return map
})
const labelForVideo = (vid: string) => {
  if (vid === 'local') return isZh.value ? '我' : 'Me'
  return peerNicknameMap.value[vid] || (isZh.value ? `远端 ${vid}` : `Peer ${vid}`)
}

// 绑定成员事件：将 WebSocket 的在线/离线同步到本地成员事件表
state.onPeerJoined = async ({ id }) => {
  const rid = sessions.currentRoomId
  if (!rid || !id) return
  // 已在列表中则忽略重复 join
  if (sessions.getCurrentMembers(rid).some(m => m.userId === id)) return
  const nick = peerNicknameMap.value[id] || (isZh.value ? `远端 ${String(id).slice(0, 6)}` : `Peer ${String(id).slice(0, 6)}`)
  try { await sessions.appendMemberEvent({ roomId: rid, userId: id, nickname: nick, eventType: 'join', ts: Date.now() }) } catch(_) {}
}
state.onPeerLeft = async ({ id }) => {
  const rid = sessions.currentRoomId
  if (!rid || !id) return
  const nick = peerNicknameMap.value[id] || (isZh.value ? `远端 ${String(id).slice(0, 6)}` : `Peer ${String(id).slice(0, 6)}`)
  try { await sessions.appendMemberEvent({ roomId: rid, userId: id, nickname: nick, eventType: 'leave', ts: Date.now() }) } catch(_) {}
}

// 显示中的信令地址
const displayedSignaling = computed(() => signalingOrigin.value || window.location.origin)

// 分享数据（包含密钥对与信令）
const shareData = computed(() => {
  let pair: any = {}
  try { pair = JSON.parse(pairText.value || '{}') } catch (_) { pair = {} }
  const signaling = manualSignalingEnabled.value && (manualSignalingUrl.value || '').trim() ? (manualSignalingUrl.value || '').trim() : ''
  const cr: any = (sessions as any).currentRoom && typeof (sessions as any).currentRoom === 'object'
    ? ((sessions as any).currentRoom as any).value ?? (sessions as any).currentRoom
    : null
  const name = (cr && cr.name) ? String(cr.name) : ''
  return { pair, signaling, name }
})
const shareJson = computed(() => JSON.stringify({ pair: shareData.value.pair, signaling: shareData.value.signaling, name: shareData.value.name }))
const shareUrl = computed(() => {
  const u = new URL(window.location.origin + '/')
  u.searchParams.set('pair', JSON.stringify(shareData.value.pair))
  if (shareData.value.signaling) u.searchParams.set('signaling', shareData.value.signaling)
  if (shareData.value.name) u.searchParams.set('name', shareData.value.name)
  return u.toString()
})
const shareQrSvg = computed(() => {
  try {
    const json = shareJson.value
    return json && json.length ? qrcodeSvg(json, { size: 200 }) : ''
  } catch (_) { return '' }
})
async function copyShareLink(){
  try{
    await navigator.clipboard.writeText(shareUrl.value)
    alert(isZh.value ? '已复制分享链接' : 'Share link copied')
  }catch(_){
    // 回退：通过 prompt 复制
    prompt(isZh.value ? '复制以下链接：' : 'Copy this link:', shareUrl.value)
  }
}

// 路由房间集成
const route = useRoute()
const user = useUser()

// 发送昵称 presence
function sendPresence(){
  try{
    const nickname = user.currentUser?.nickname || (isZh.value ? '未命名' : 'Unnamed')
    const payload = JSON.stringify({ __type: 'presence', nickname })
    state.chatInput = payload
    state.sendChat()
  }catch(_){ /* ignore */ }
}

// 防重复开始：UI 层状态
const isStarting = ref(false)
const startDisabled = computed(() => isStarting.value || connected.value || !!(state.socket && (state.socket as any).connected))
async function handleStart(){
  if (startDisabled.value) return
  isStarting.value = true
  try { await start() } finally { /* 等待 connected 置位后再清除 */ }
}
function handleStop(){
  try { stop() } finally { isStarting.value = false }
}

async function applyRoomFromDB() {
  const roomId = String((route.params as any).id || '')
  if (!roomId) return
  sessions.currentRoomId = roomId
  if (!(sessions.rooms as Room[]).find((r: Room) => r.id === roomId)) {
    await sessions.loadRooms()
  }
  const room = (sessions.rooms as Room[]).find((r: Room) => r.id === roomId) || null
  if (!room) {
    alert(isZh.value ? '未找到房间或无权限访问' : 'Room not found or no access')
    return
  }
  pairText.value = room.pairText || ''
  manualSignalingEnabled.value = !!room.manualSignalingEnabled
  manualSignalingUrl.value = room.manualSignalingUrl || ''
  try { loadPair() } catch(_) {}
  try { saveManualSignaling() } catch(_) {}

  // 设置聊天消息持久化钩子（含 presence 解析）
  state.onChatMessage = async ({ from, text, ts }) => {
    const rid = String((route.params as any).id || '')
    if (!rid) return
    // 尝试解析 presence
    try{
      if (typeof text === 'string' && text.trim().startsWith('{')){
        const obj = JSON.parse(text)
        if (obj && obj.__type === 'presence' && typeof obj.nickname === 'string'){
          // 若昵称未变化则忽略
          if (peerNicknameMap.value[(from || '')] === obj.nickname) return
          await sessions.appendMemberEvent({ roomId: rid, userId: from || 'unknown', nickname: obj.nickname, eventType: 'join', ts })
          return // presence 不写入聊天记录
        }
      }
    }catch(_){ /* ignore parse errors */ }

    await sessions.appendMessage(rid, {
      roomId: rid,
      userIdFrom: from || (user.currentUser?.id || 'unknown'),
      content: text,
      ts,
    })
    // 更新房间活跃时间
    try {
      await db.rooms.update(rid, { updatedAt: ts })
      const idx = (sessions.rooms as Room[]).findIndex((r: Room) => r.id === rid)
      if (idx >= 0) (sessions.rooms as Room[])[idx].updatedAt = ts
    } catch(_) {}
  }

  // 预加载该房间消息与成员
  await sessions.loadMessagesFor(roomId)
  await sessions.loadMembersFor(roomId)
}

watch(() => (route.params as any).id, () => { applyRoomFromDB() })

watch(connected, (v) => { if (v) { isStarting.value = false; sendPresence() } })

onMounted(() => {
  applyRoomFromDB()
})

// 将页面内的关键配置变动持久化到 Dexie
watch(pairText, async (v) => {
  const rid = sessions.currentRoomId
  if (!rid) return
  try {
    await db.rooms.update(rid, { pairText: v || '' })
    const i = (sessions.rooms as Room[]).findIndex((r: Room) => r.id === rid)
    if (i >= 0) (sessions.rooms as Room[])[i].pairText = v || ''
  } catch (_) {}
})
watch(() => [manualSignalingEnabled.value, manualSignalingUrl.value] as const, async ([en, url]) => {
  const rid = sessions.currentRoomId
  if (!rid) return
  try {
    await db.rooms.update(rid, { manualSignalingEnabled: !!en, manualSignalingUrl: url || '' })
    const i = (sessions.rooms as Room[]).findIndex((r: Room) => r.id === rid)
    if (i >= 0) {
      (sessions.rooms as Room[])[i].manualSignalingEnabled = !!en;
      (sessions.rooms as Room[])[i].manualSignalingUrl = url || '';
    }
  } catch (_) {}
})

// 视频显示 ID：本地 + 最多 8 个远端（合计 9 个）
const displayedVideoIds = computed(() => {
  const ids = ['local', ...remotePeers.value]
  return ids.slice(0, 9)
})

// 动态网格列行：1=>1列；2=>2列；3-4=>2列；5-9=>3列
const videoGridStyle = computed(() => {
  const n = displayedVideoIds.value.length
  let cols = 1
  if (n === 2) cols = 2
  else if (n >= 3 && n <= 4) cols = 2
  else if (n >= 5) cols = 3
  const rows = Math.ceil(n / cols)
  return {
    gridTemplateColumns: `repeat(${cols}, 1fr)`,
    gridTemplateRows: `repeat(${rows}, 1fr)`
  } as Record<string, string>
})

function sessionWatch(){
  // 监听 membersMap 变化以更新标签（若有需要可扩展）
  watch(() => sessions.membersMap[sessions.currentRoomId], () => {}, { deep: true })
}
</script>

<style scoped>
:root { color-scheme: light dark; }
* { box-sizing: border-box; }
body { margin: 0; }

.page { display: grid; grid-template-rows: auto auto auto 1fr; gap: 12px; padding: 12px; height: 100vh; }

/* 顶部条与房间标签 */
.room-tabs { display: flex; gap: 8px; align-items: center; overflow: auto; }
.room-tab { padding: 8px 12px; border: 1px solid #e5e5e5; border-radius: 999px; cursor: pointer; background: #fff; color: #374151; }
.room-tab.active { background: #2563eb; color: #fff; border-color: #2563eb; }
.tab-name { font-size: 13px; font-weight: 600; }

/* 视频九宫格（动态） */
.video-grid { display: grid; gap: 8px; height: 50vh; grid-auto-rows: 1fr; }
.video-cell { position: relative; background: #000; border-radius: 8px; overflow: hidden; }
.video-cell video { width: 100%; height: 100%; object-fit: cover; display: block; }
.video-label { position: absolute; left: 8px; bottom: 8px; padding: 2px 6px; background: rgba(0,0,0,0.55); color: #fff; font-size: 12px; border-radius: 4px; }

/* 常用 UI */
.h2 { font-size: 18px; font-weight: 600; margin: 0 0 8px; }
.h3 { font-size: 16px; font-weight: 600; margin: 0 0 8px; }
.desc { color: #666; font-size: 13px; margin: 0 0 12px; }
.small { font-size: 12px; }
.muted { color: #777; }
.card { border: 1px solid #e3e3e3; border-radius: 8px; padding: 16px; background: rgba(250,250,250,0.6); }
.row { display: flex; align-items: center; }
.gap { gap: 8px; flex-wrap: wrap; }
.center { align-items: center; }
.right { justify-content: flex-end; }
.space-between { justify-content: space-between; }
.grid-2 { display: grid; grid-template-columns: repeat(1, minmax(0,1fr)); gap: 16px; }
@media (min-width: 900px) {
  .grid-2 { grid-template-columns: repeat(2, minmax(0,1fr)); }
}
.label { display: block; margin: 8px 0 6px; font-size: 14px; }
.label-inline { display: inline-flex; align-items: center; gap: 8px; font-size: 13px; color: #444; }
.input, .select, .textarea { width: 100%; padding: 8px 10px; border: 1px solid #dcdcdc; border-radius: 6px; font-size: 14px; background: #fff; color: #222; }
.textarea { height: 120px; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
.btn { padding: 8px 14px; border-radius: 6px; border: 1px solid #d0d0d0; background: #f7f7f7; color: #222; cursor: pointer; }
.btn:hover { background: #f0f0f0; }
.btn-primary { background: #2563eb; color: #fff; border-color: #2563eb; }
.btn-primary:hover { background: #1d4ed8; }
.btn-outline { background: #fff; color: #222; }
.chatbox { height: 220px; overflow: auto; border: 1px solid #eee; border-radius: 6px; padding: 8px; background: rgba(249,249,249,0.7); }
.chatline { font-size: 14px; line-height: 1.6; }
.logbox { height: 220px; overflow: auto; border: 1px solid #eee; border-radius: 6px; padding: 8px; background: rgba(249,249,249,0.7); font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace; font-size: 12px; }
.logline { white-space: pre-wrap; word-break: break-word; }
.flex1 { flex: 1; min-width: 240px; }
.dot { width: 10px; height: 10px; border-radius: 999px; display: inline-block; margin-right: 6px; background: #9ca3af; }
.dot.green { background: #16a34a; }
.dot.gray { background: #9ca3af; }
.ml-4 { margin-left: 8px; }
.mt-4 { margin-top: 4px; }
.mt-8 { margin-top: 8px; }
.mt-12 { margin-top: 12px; }
.mb-8 { margin-bottom: 8px; }
.qrbox { width: 220px; height: 220px; border: 1px solid #e5e5e5; border-radius: 8px; display: flex; align-items: center; justify-content: center; background: #fff; padding: 12px; }
.share-block { border-top: 1px dashed #e5e5e5; padding-top: 12px; margin-top: 12px; }

/* 成员列表 */
.memberbox { border: 1px solid #eee; border-radius: 6px; padding: 8px; background: rgba(249,249,249,0.7); }
.memberlist { display: flex; flex-direction: column; gap: 6px; }
.memberline { display: flex; align-items: center; font-size: 14px; }
</style>

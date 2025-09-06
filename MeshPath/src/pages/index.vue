<template>
  <div class="sessions-page">
    <!-- Lang toggle -->
    <div style="display:flex; justify-content:flex-end; margin-bottom:8px">
      <button class="btn" @click="toggleLang">{{ isZh ? 'EN' : '中文' }}</button>
    </div>
    
    <!-- 未登录状态：显示登录/注册界面 -->
    <div v-if="!user.isAuthed" class="auth-section">
      <div class="card auth-card">
        <h1 class="h1">MeshPath</h1>
        <p class="desc">{{ isZh ? '基于 WebRTC + E2EE 的去中心化视频通话平台' : 'Decentralized video calls powered by WebRTC + E2EE' }}</p>
        
        <!-- 登录表单 -->
        <div class="auth-form">
          <h2 class="h2">{{ isZh ? '用户登录' : 'Login' }}</h2>
          <p class="small muted">{{ isZh ? '使用现有密钥对登录' : 'Login with an existing key pair' }}</p>
          <textarea 
            v-model="user.loginPairText" 
            class="textarea" 
            placeholder='{"pub":"...","priv":"..."}'
            :disabled="user.loading"
          ></textarea>
          <button 
            class="btn btn-primary" 
            @click="handleLogin"
            :disabled="user.loading || !user.loginPairText.trim()"
          >
            {{ user.loading ? (isZh ? '登录中...' : 'Logging in...') : (isZh ? '登录' : 'Login') }}
          </button>
        </div>

        <!-- 注册表单 -->
        <div class="auth-form">
          <h2 class="h2">{{ isZh ? '用户注册' : 'Register' }}</h2>
          <p class="small muted">{{ isZh ? '自动生成新密钥对并设置昵称' : 'Generate a new key pair and set a nickname' }}</p>
          <input 
            v-model="user.registerNickname" 
            class="input" 
            :placeholder="isZh ? '输入昵称' : 'Enter nickname'"
            :disabled="user.loading"
          />
          <button 
            class="btn btn-outline" 
            @click="handleRegister"
            :disabled="user.loading || !user.registerNickname.trim()"
          >
            {{ user.loading ? (isZh ? '注册中...' : 'Registering...') : (isZh ? '注册' : 'Register') }}
          </button>
        </div>
      </div>
    </div>

    <!-- 已登录状态：显示会话列表 -->
    <div v-else class="main-section">
      <!-- 用户信息栏 -->
      <div class="user-bar card">
        <div class="user-info">
          <h2 class="h2">{{ user.currentUser?.nickname || (isZh ? '未知用户' : 'Unknown user') }}</h2>
          <p class="small muted">{{ (user.currentUser?.pub?.slice(0, 16) || '') + '...' }}</p>
        </div>
        <button class="btn btn-outline" @click="user.logout">{{ isZh ? '退出登录' : 'Log out' }}</button>
      </div>

      <!-- 房间管理：创建/加入 -->
      <div class="room-actions card">
        <div class="grid-2">
          <!-- 创建房间 -->
          <div>
            <h3 class="h3">{{ isZh ? '创建房间' : 'Create room' }}</h3>
            <div class="row gap mt-8">
              <input 
                v-model="sessions.createRoomName" 
                class="input flex1" 
                :placeholder="isZh ? '房间名称' : 'Room name'"
              />
              <button class="btn btn-primary" @click="sessions.createRoom">{{ isZh ? '创建' : 'Create' }}</button>
            </div>
            <input 
              v-model="sessions.createRoomSignaling" 
              class="input mt-8" 
              :placeholder="isZh ? '信令地址（可选）' : 'Signaling URL (optional)'"
            />
          </div>

          <!-- 加入房间 -->
          <div>
            <h3 class="h3">{{ isZh ? '加入房间' : 'Join room' }}</h3>
            <div class="row gap mt-8">
              <input 
                v-model="sessions.joinInput" 
                class="input flex1" 
                :placeholder="isZh ? '粘贴分享链接或JSON' : 'Paste share link or JSON'"
              />
              <button class="btn btn-outline" @click="handleJoin">{{ isZh ? '加入' : 'Join' }}</button>
            </div>
          </div>
        </div>
      </div>

      <!-- 会话列表 -->
      <div class="sessions-list card">
        <h3 class="h3">{{ isZh ? '会话列表' : 'Sessions' }}</h3>
        <div v-if="sessions.rooms.length === 0" class="empty-state">
          <p class="muted">{{ isZh ? '暂无会话，请创建或加入房间' : 'No sessions yet. Create or join a room.' }}</p>
        </div>
        <div v-else class="sessions-items">
          <div 
            v-for="room in sessions.rooms" 
            :key="room.id"
            class="session-item"
            @click="enterRoom(room.id)"
          >
            <div class="session-content">
              <h4 class="session-name">{{ room.name }}</h4>
              <p class="session-last-msg">{{ getLastMessage(room.id) }}</p>
              <div class="session-meta">
                <span class="session-time">{{ formatTime(room.updatedAt) }}</span>
                <span class="session-signaling" v-if="room.manualSignalingUrl">
                  • {{ room.manualSignalingUrl }}
                </span>
              </div>
            </div>
            <div class="session-actions">
              <button class="btn btn-outline btn-danger" @click.stop="handleDelete(room.id)">{{ isZh ? '删除' : 'Delete' }}</button>
            </div>
            <div class="session-arrow">→</div>
          </div>
        </div>
      </div>

      <!-- 网状聊天（文本） -->
      <div class="mesh-chat card mt-16">
        <div class="row space-between align-center">
          <h3 class="h3">{{ isZh ? '网状聊天（文本 Beta）' : 'Mesh chat (Text Beta)' }}</h3>
          <div class="small muted">{{ isZh ? '上次同步：' : 'Last sync: ' }}{{ mesh.lastPollAt ? formatTime(mesh.lastPollAt) : (isZh ? '从未' : 'Never') }}</div>
        </div>

        <!-- 服务端管理 -->
        <div class="server-manage mt-12">
          <h4 class="h4">{{ isZh ? '服务端连接' : 'Server connections' }}</h4>
          <div class="row gap mt-8">
            <input v-model="newServerUrl" class="input flex1" :placeholder="isZh ? '输入服务端 URL，如 http://127.0.0.1:3030' : 'Enter server URL, e.g. http://127.0.0.1:3030'" />
            <button class="btn btn-outline" @click="handleAddServer">{{ isZh ? '添加' : 'Add' }}</button>
          </div>
          <div class="servers mt-8" v-if="user.servers.length">
            <div v-for="s in user.servers" :key="s.url" class="server-item row space-between align-center">
              <div>
                <div class="bold">{{ s.url }}</div>
                <div class="small muted">{{ isZh ? '状态：' : 'Status: ' }}{{ s.lastStatus || 'unknown' }}{{ isZh ? '，' : ', ' }}{{ s.enabled ? (isZh ? '已启用' : 'enabled') : (isZh ? '已禁用' : 'disabled') }}</div>
              </div>
              <div class="row gap">
                <button class="btn btn-outline" @click="toggleServer(s.url, !s.enabled)">{{ s.enabled ? (isZh ? '禁用' : 'Disable') : (isZh ? '启用' : 'Enable') }}</button>
                <button class="btn" @click="handlePing(s.url)">Ping</button>
                <button class="btn btn-danger" @click="removeServer(s.url)">{{ isZh ? '删除' : 'Delete' }}</button>
              </div>
            </div>
          </div>
        </div>

        <div class="grid-2 mt-16">
          <!-- 文本房间 -->
          <div>
            <h4 class="h4">{{ isZh ? '文本房间' : 'Text rooms' }}</h4>
            <div class="row gap mt-8">
              <input v-model="mesh.newRoomName" class="input flex1" :placeholder="isZh ? '新建房间名称' : 'New room name'" />
              <button class="btn btn-primary" @click="mesh.createTextRoom">{{ isZh ? '新建' : 'Create' }}</button>
            </div>
            <div class="row gap mt-8">
              <input v-model="mesh.joinInput" class="input flex1" :placeholder="joinJsonPlaceholder" />
              <button class="btn btn-outline" @click="mesh.joinTextRoomByJSON">{{ isZh ? '加入' : 'Join' }}</button>
            </div>
            <div class="rooms mt-12">
              <div v-for="r in mesh.rooms" :key="r.id" class="room-item row space-between align-center" @click="mesh.selectRoom(r.id)">
                <div>
                  <div class="bold">{{ r.name }}</div>
                  <div class="small muted">{{ r.id.slice(0, 16) }}...</div>
                </div>
                <div class="small">{{ mesh.currentRoomId === r.id ? (isZh ? '当前' : 'Current') : (isZh ? '进入' : 'Enter') }}</div>
              </div>
            </div>
          </div>

          <!-- 消息列表 -->
          <div>
            <h4 class="h4">{{ isZh ? '消息' : 'Messages' }}</h4>
            <div class="messages">
              <div v-if="!mesh.currentRoom">{{ isZh ? '请选择一个文本房间' : 'Please select a text room' }}</div>
              <template v-else>
                <div class="message" v-for="m in mesh.currentMessages" :key="m.id">
                  <div class="small muted">{{ m.senderPub.slice(0, 8) }} • {{ formatTime(m.ts) }}</div>
                  <div>{{ m.content }}</div>
                </div>
              </template>
            </div>
            <div class="row gap mt-8">
              <button class="btn btn-primary" :disabled="!mesh.currentRoom || mesh.sending" @click="mesh.sendTextMessage">
                {{ mesh.sending ? (isZh ? '发送中...' : 'Sending...') : (isZh ? '发送消息' : 'Send message') }}
              </button>
              <button class="btn" :disabled="mesh.polling" @click="mesh.pollOnce">{{ mesh.polling ? (isZh ? '同步中...' : 'Syncing...') : (isZh ? '立即同步' : 'Sync now') }}</button>
            </div>
            <div class="row gap mt-8" v-if="mesh.currentRoom">
              <button class="btn" @click="copyTextRoomJSON">{{ isZh ? '复制房间 JSON' : 'Copy room JSON' }}</button>
              <button class="btn" @click="copyTextRoomLink">{{ isZh ? '复制分享链接' : 'Copy share link' }}</button>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { useUser } from '@/composables/useUser'
import { useSessions } from '@/composables/useSessions'
import { useRouter } from 'vue-router'
import { useMeshChat } from '@/composables/useMeshChat'
import { ref, onMounted, computed } from 'vue'
import { useLang } from '@/composables/useLang'

const { isZh, toggle } = useLang()
const toggleLang = () => toggle()
const joinJsonPlaceholder = computed(() => isZh.value ? '粘贴文本房间 JSON：{"rpub":"...","rpriv":"..."}' : 'Paste text room JSON: {"rpub":"...","rpriv":"..."}')

const user = useUser()
const sessions = useSessions()
const router = useRouter()
const mesh = useMeshChat()

const newServerUrl = ref('')

async function handleLogin() {
  const result = await user.loginWithPair(user.loginPairText)
  if (!result.ok) {
    alert(result.message || (isZh.value ? '登录失败' : 'Login failed'))
  } else {
    user.loginPairText = ''
  }
}

async function handleRegister() {
  const result = await user.registerNew(user.registerNickname)
  if (!result.ok) {
    alert(result.message || (isZh.value ? '注册失败' : 'Register failed'))
  } else {
    user.registerNickname = ''
  }
}

async function handleJoin() {
  const result = await sessions.joinByShare(sessions.joinInput)
  if (!result.ok) {
    alert(result.message || (isZh.value ? '加入失败' : 'Join failed'))
  }
}

function enterRoom(roomId: string) {
  router.push(`/room/${roomId}`)
}

async function handleDelete(roomId: string) {
  const ok = confirm(isZh.value ? '确认删除该会话及其所有消息？此操作不可恢复。' : 'Delete this session and all messages? This action cannot be undone.')
  if (!ok) return
  await sessions.deleteRoom(roomId)
}

function getLastMessage(roomId: string): string {
  const messages = sessions.messagesMap[roomId] || []
  if (messages.length === 0) return isZh.value ? '暂无消息' : 'No messages'
  const last = messages[messages.length - 1]
  return last.content.length > 30 ? last.content.slice(0, 30) + '...' : last.content
}

function formatTime(ts: number): string {
  const now = Date.now()
  const diff = now - ts
  if (diff < 60000) return isZh.value ? '刚刚' : 'just now'
  if (diff < 3600000) return isZh.value ? `${Math.floor(diff / 60000)} 分钟前` : `${Math.floor(diff / 60000)} minutes ago`
  if (diff < 86400000) return isZh.value ? `${Math.floor(diff / 3600000)} 小时前` : `${Math.floor(diff / 3600000)} hours ago`
  return isZh.value ? `${Math.floor(diff / 86400000)} 天前` : `${Math.floor(diff / 86400000)} days ago`
}

function handleAddServer() {
  if (!newServerUrl.value.trim()) return
  user.addServer(newServerUrl.value)
  newServerUrl.value = ''
}
function toggleServer(url: string, enabled: boolean) {
  user.setServerEnabled(url, enabled)
}
function removeServer(url: string) {
  user.removeServer(url)
}
async function handlePing(url: string) {
  await user.pingServer(url)
}

async function copyTextRoomJSON() {
  const room = (mesh as any).currentRoom as any
  if (!room) return
  const share = { name: room.name, rpub: room.rpub, rpriv: room.rpriv }
  const text = JSON.stringify(share)
  try {
    await navigator.clipboard.writeText(text)
    alert(isZh.value ? '已复制房间 JSON，邀请方可在“粘贴文本房间 JSON”框中粘贴加入。' : 'Room JSON copied. Invitee can paste it into the "Paste text room JSON" box to join.')
  } catch (_) {
    prompt(isZh.value ? '复制失败，请手动复制以下内容：' : 'Copy failed, please copy manually:', text)
  }
}

async function copyTextRoomLink() {
  const room = (mesh as any).currentRoom as any
  if (!room) return
  const share = { name: room.name, rpub: room.rpub, rpriv: room.rpriv }
  const payload = encodeURIComponent(JSON.stringify(share))
  const base = `${location.origin}${location.pathname}`
  const link = `${base}?mesh_text_room=${payload}`
  try {
    await navigator.clipboard.writeText(link)
    alert(isZh.value ? '已复制分享链接，受邀者打开后将自动填充加入框（仍需点击加入）。' : 'Share link copied. The invitee can open it to auto-fill the join box (still need to click Join).')
  } catch (_) {
    prompt(isZh.value ? '复制失败，请手动复制以下链接：' : 'Copy failed, please copy this link:', link)
  }
}

onMounted(() => {
  try {
    const params = new URLSearchParams(location.search)
    const q = params.get('mesh_text_room')
    if (q) {
      try { (mesh as any).joinInput = decodeURIComponent(q) } catch { (mesh as any).joinInput = q }
    }
  } catch (_) { /* ignore */ }
})
</script>

// removed duplicate script setup block

<style scoped>
.sessions-page {
  padding: 20px;
  max-width: 1200px;
  margin: 0 auto;
  min-height: 100vh;
  display: flex;
  flex-direction: column;
}

/* 认证界面 */
.auth-section {
  display: flex;
  justify-content: center;
  align-items: center;
  min-height: 100vh;
}

.auth-card {
  max-width: 500px;
  width: 100%;
  text-align: center;
}

.auth-form {
  margin-top: 32px;
  text-align: left;
}

.auth-form + .auth-form {
  margin-top: 24px;
  padding-top: 24px;
  border-top: 1px solid #e5e5e5;
}

/* 主界面 */
.main-section {
  display: flex;
  flex-direction: column;
  gap: 20px;
}

.user-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
}

.user-info h2 {
  margin: 0;
}

.room-actions .grid-2 {
  display: grid;
  grid-template-columns: 1fr;
  gap: 20px;
}

@media (min-width: 768px) {
  .room-actions .grid-2 {
    grid-template-columns: 1fr 1fr;
  }
}

/* 会话列表 */
.sessions-list {
  flex: 1;
}

.empty-state {
  padding: 40px;
  text-align: center;
}

.sessions-items {
  display: flex;
  flex-direction: column;
  gap: 12px;
  margin-top: 16px;
}

.session-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px;
  border: 1px solid #e5e5e5;
  border-radius: 8px;
  cursor: pointer;
  transition: all 0.2s ease;
  background: rgba(255, 255, 255, 0.5);
}

.session-item:hover {
  background: rgba(37, 99, 235, 0.05);
  border-color: #2563eb;
}

.session-content {
  flex: 1;
}

.session-actions {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-right: 8px;
}

.session-name {
  margin: 0 0 4px 0;
  font-size: 16px;
  font-weight: 600;
  color: #1f2937;
}

.session-last-msg {
  margin: 0 0 8px 0;
  font-size: 14px;
  color: #6b7280;
  line-height: 1.4;
}

.session-meta {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 12px;
  color: #9ca3af;
}

.session-arrow {
  font-size: 18px;
  color: #9ca3af;
}

/* 通用样式 */
.h1 {
  font-size: 28px;
  font-weight: 700;
  margin: 0 0 8px 0;
  color: #1f2937;
}

.h2 {
  font-size: 20px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: #1f2937;
}

.h3 {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 8px 0;
  color: #1f2937;
}

.desc {
  color: #6b7280;
  margin: 0 0 24px 0;
  line-height: 1.5;
}

.small {
  font-size: 13px;
}

.muted {
  color: #6b7280;
}

.card {
  background: rgba(255, 255, 255, 0.8);
  border: 1px solid #e5e5e5;
  border-radius: 12px;
  padding: 24px;
  backdrop-filter: blur(10px);
}

.row {
  display: flex;
  align-items: center;
}

.gap {
  gap: 12px;
}

.flex1 {
  flex: 1;
}

.mt-8 {
  margin-top: 8px;
}

.input, .textarea {
  width: 100%;
  padding: 12px 16px;
  border: 1px solid #d1d5db;
  border-radius: 8px;
  font-size: 14px;
  transition: border-color 0.2s ease;
}

.input:focus, .textarea:focus {
  outline: none;
  border-color: #2563eb;
  box-shadow: 0 0 0 3px rgba(37, 99, 235, 0.1);
}

.textarea {
  height: 120px;
  resize: vertical;
  font-family: 'Monaco', 'Menlo', 'Ubuntu Mono', monospace;
  font-size: 12px;
}

.btn {
  padding: 12px 20px;
  border-radius: 8px;
  border: 1px solid #d1d5db;
  background: #f9fafb;
  color: #374151;
  cursor: pointer;
  font-size: 14px;
  font-weight: 500;
  transition: all 0.2s ease;
}

.btn:hover:not(:disabled) {
  background: #f3f4f6;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-primary {
  background: #2563eb;
  color: white;
  border-color: #2563eb;
}

.btn-primary:hover:not(:disabled) {
  background: #1d4ed8;
}

.btn-outline {
  background: transparent;
  color: #2563eb;
  border-color: #2563eb;
}

.btn-outline:hover:not(:disabled) {
  background: rgba(37, 99, 235, 0.05);
}

.btn-danger {
  color: #ef4444;
  border-color: #ef4444;
}

.btn-danger:hover:not(:disabled) {
  background: rgba(239, 68, 68, 0.08);
}
.mesh-chat .servers .server-item { padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06) }
.mesh-chat .rooms .room-item { padding: 8px 0; border-bottom: 1px solid rgba(0,0,0,0.06); cursor: pointer }
.mesh-chat .messages { max-height: 260px; overflow: auto; border: 1px solid rgba(0,0,0,0.06); padding: 8px; border-radius: 6px }
.mesh-chat .message { padding: 6px 0; border-bottom: 1px dashed rgba(0,0,0,0.06) }
</style>
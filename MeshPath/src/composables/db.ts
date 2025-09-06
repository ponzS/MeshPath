import Dexie, { type Table } from 'dexie'

export interface User {
  id: string
  pub: string
  priv: string
  nickname: string
  createdAt: number
  lastLoginAt: number
}

export interface Room {
  id: string
  userId: string
  name: string
  pairText: string
  manualSignalingEnabled: boolean
  manualSignalingUrl: string
  updatedAt: number
}

export interface Message {
  id?: number
  roomId: string
  userIdFrom: string
  content: string
  ts: number
}

export interface MemberEvent {
  id?: number
  roomId: string
  userId: string
  nickname: string
  eventType: 'join' | 'leave'
  ts: number
}

// 文本聊天：房间（共享密钥对）、消息、联系人、成员事件
export interface TextRoom {
  id: string // 文本房间ID
  ownerUserId: string // 本地用户 ID
  name: string
  rpub: string // 房间加密公钥（共享）
  rpriv: string // 房间加密私钥（共享，保存在本地）
  createdAt: number
  updatedAt: number
}

export interface TextMessage {
  id?: number
  roomId: string
  senderPub: string // 发送方的签名或身份公钥（可用于标识）
  content: string // 已解密明文
  raw?: string // 可选：原始加密载荷 JSON 字符串
  ts: number
}

export interface Contact {
  id: string // 对端身份公钥（或其他唯一ID）
  nickname: string
  epub?: string // 对端的加密公钥（若已知）
  note?: string
  addedAt: number
  lastSeenAt: number
}

export interface TextMemberEvent {
  id?: number
  roomId: string
  userId: string // 加入/离开成员的身份（公钥）
  nickname: string
  eventType: 'join' | 'leave' | 'nick'
  ts: number
}

class MeshPathDB extends Dexie {
  users!: Table<User, string>
  rooms!: Table<Room, string>
  messages!: Table<Message, number>
  memberEvents!: Table<MemberEvent, number>
  // 新增
  textRooms!: Table<TextRoom, string>
  textMessages!: Table<TextMessage, number>
  contacts!: Table<Contact, string>
  textMembers!: Table<TextMemberEvent, number>

  constructor() {
    super('meshpath')
    // 兼容旧表结构，版本2保留；版本3新增文本聊天相关表
    this.version(2).stores({
      users: 'id, pub, nickname, lastLoginAt',
      rooms: 'id, userId, updatedAt',
      messages: '++id, roomId, ts',
      memberEvents: '++id, roomId, userId, eventType, ts'
    })
    this.version(3).stores({
      users: 'id, pub, nickname, lastLoginAt',
      rooms: 'id, userId, updatedAt',
      messages: '++id, roomId, ts',
      memberEvents: '++id, roomId, userId, eventType, ts',
      textRooms: 'id, ownerUserId, updatedAt',
      textMessages: '++id, roomId, ts',
      contacts: 'id, nickname, lastSeenAt',
      textMembers: '++id, roomId, userId, eventType, ts'
    })
  }
}

export const db = new MeshPathDB()

export const LS_CURRENT_USER = 'mesh_current_user_id'
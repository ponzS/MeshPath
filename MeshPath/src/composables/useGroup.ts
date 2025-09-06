import { reactive, nextTick, onMounted } from 'vue'
import { io, Socket } from 'socket.io-client'
import * as unsea from 'unsea'
import qrcodeSvg from '@qrcode/svg'


export function useGroup(){
  const state = reactive({
    status: 'connecting',
    pulse: 0,
    started: 0,
    store: false,
    host: '',
    activeWires: 0,

    // QR code state
    qrCodeSvg: '',

    // keys
    pairText: (typeof localStorage !== 'undefined' ? localStorage.getItem('room_pair') : '') || '',
    pair: null as any,
    roomPub: '',
    hasPrivate: false,

    // devices
    devices: { audioIn: [] as MediaDeviceInfo[], videoIn: [] as MediaDeviceInfo[] },
    selectedAudioIn: '',
    selectedVideoIn: '',
    enableMic: true,
    enableCam: true,
    enableE2EE: true,
    enableChatE2EE: true,

    // connection
    connected: false,
    socket: null as null | Socket,
    peers: {} as Record<string, RTCPeerConnection>,
    remoteStreams: {} as Record<string, MediaStream>,
    remotePeers: [] as string[],
    localStream: null as MediaStream | null,
    others: [] as string[],
    selfId: '',
    log: [] as { t: string; m: string }[],
    iceServers: [] as RTCIceServer[],
    signalingOrigin: '',

    // Manual signaling config
    manualSignalingEnabled: (typeof localStorage !== 'undefined' && localStorage.getItem('manual_signaling_enabled') === '1'),
    manualSignalingUrl: (typeof localStorage !== 'undefined' && (localStorage.getItem('manual_signaling_url') || 'http://localhost:8765')) || 'http://localhost:8765',

    // E2EE session materials
    e2eeKey: null as CryptoKey | null,
    e2eeSalt: null as Uint8Array | null,
    // Chat E2EE materials (derived from room private key)
    chatKey: null as CryptoKey | null,
    chatSalt: null as Uint8Array | null,

    // Chat state
    chatMessages: [] as { from: string; text: string; ts: number }[],
    chatInput: '',

    // 外部钩子：当有聊天消息（明文或已解密）到达时触发
    onChatMessage: null as (null | ((payload: { from: string; text: string; ts: number }) => void)),
    // 外部钩子：成员在线事件（用于 Dexie 成员表同步）
    onPeerJoined: null as (null | ((payload: { id: string }) => void)),
    onPeerLeft: null as (null | ((payload: { id: string }) => void)),

    addLog(m: string){ (state as any).log.unshift({ t: new Date().toLocaleTimeString(), m }); if ((state as any).log.length > 200) (state as any).log.pop(); },

    // Chat: send message and Enter key handler
    sendChat(){
      if (!state.socket || !state.connected) return;
      const text = (state.chatInput || '').trim();
      if (!text) return;
      state.addLog('聊天发送：'+JSON.stringify({ 长度: text.length, 加密: !!state.enableChatE2EE }));
      if (state.enableChatE2EE && state.chatKey) {
        (async ()=>{
          try{
            const iv = crypto.getRandomValues(new Uint8Array(12));
            const ct = await crypto.subtle.encrypt({ name:'AES-GCM', iv }, state.chatKey as CryptoKey, new TextEncoder().encode(text));
            const ctB64 = state.b64encode(ct);
            const ivB64 = state.b64encode(iv);
            state.socket!.emit('chat', { ct: ctB64, iv: ivB64, ts: Date.now() });
          }catch(e: any){ state.addLog('聊天加密失败，改为明文发送：'+(e?.message||e)); state.socket!.emit('chat', { text }); }
        })();
      } else {
        state.socket.emit('chat', { text });
      }
      state.chatInput = '';
    },
    sendChatOnEnter(e: KeyboardEvent & { isComposing?: boolean }){
      try{ if (e && (e as any).isComposing) return; }catch(_){/* ignore */}
      state.sendChat();
    },

    // Key pair & QR helpers
    async generatePair(){
      const pair = await unsea.generateRandomPair();
      (state as any).pair = pair;
      state.pairText = JSON.stringify(pair, null, 2);
      state.roomPub = pair.pub;
      state.hasPrivate = !!pair.priv;
      try{ localStorage.setItem('room_pair', state.pairText); }catch(_){/* ignore */}
      state.updateQRCode();
    },
    loadPair(){
      try{
        const json = JSON.parse(state.pairText || '{}');
        (state as any).pair = json; state.roomPub = json.pub; state.hasPrivate = !!json.priv;
        localStorage.setItem('room_pair', JSON.stringify(json));
        state.updateQRCode();
      }catch(_){ /* ignore */ }
    },
    updateQRCode(){
      try{
        if (state.pairText && state.pairText.trim()) {
          state.qrCodeSvg = qrcodeSvg(state.pairText, { size: 200 });
        } else {
          state.qrCodeSvg = '';
        }
      }catch(_e){ state.qrCodeSvg = ''; }
    },

    saveManualSignaling(){
      try{ localStorage.setItem('manual_signaling_enabled', state.manualSignalingEnabled ? '1' : '0'); }catch(_){/* ignore */}
      try{ if (state.manualSignalingUrl) localStorage.setItem('manual_signaling_url', state.manualSignalingUrl); }catch(_){/* ignore */}
      if (!state.connected) {
        if (state.manualSignalingEnabled && state.manualSignalingUrl) {
          state.signalingOrigin = state.manualSignalingUrl;
          state.addLog('Using manual signaling: ' + state.signalingOrigin);
        }
      }
    },

    // media
    async enumerate(){
      const devices = await navigator.mediaDevices.enumerateDevices();
      state.devices.audioIn = devices.filter(d=>d.kind==='audioinput');
      state.devices.videoIn = devices.filter(d=>d.kind==='videoinput');
      if (!state.selectedAudioIn && state.devices.audioIn[0]) state.selectedAudioIn = state.devices.audioIn[0].deviceId;
      if (!state.selectedVideoIn && state.devices.videoIn[0]) state.selectedVideoIn = state.devices.videoIn[0].deviceId;
    },
    async getLocalStream(){
      const constraints: MediaStreamConstraints = {
        audio: state.enableMic ? { deviceId: state.selectedAudioIn ? { exact: state.selectedAudioIn } as any : undefined } : false,
        video: state.enableCam ? { deviceId: state.selectedVideoIn ? { exact: state.selectedVideoIn } as any : undefined } : false,
      }
      state.localStream = await navigator.mediaDevices.getUserMedia(constraints);
      const el = document.getElementById('localVideo') as HTMLVideoElement | null;
      if (el) { el.srcObject = state.localStream; await el.play().catch(()=>{}); }
    },

    // Helpers: base64 encode/decode for ArrayBuffer/Uint8Array
    b64encode(buf: ArrayBuffer | Uint8Array){
      try{
        const b = (buf instanceof Uint8Array) ? buf : new Uint8Array(buf);
        let bin = '';
        for (let i=0;i<b.length;i++) bin += String.fromCharCode(b[i]);
        return btoa(bin);
      }catch(e: any){ state.addLog('b64 编码错误：'+(e?.message||e)); return ''; }
    },
    b64decode(b64: string){
      try{
        const bin = atob(b64);
        const len = bin.length;
        const bytes = new Uint8Array(len);
        for (let i=0;i<len;i++) bytes[i] = bin.charCodeAt(i);
        return bytes;
      }catch(e: any){ state.addLog('b64 解码错误：'+(e?.message||e)); return new Uint8Array(); }
    },

    // E2EE helpers
    async deriveRoomKey(){
      const enc = new TextEncoder();
      const hash = await crypto.subtle.digest('SHA-256', enc.encode(state.roomPub));
      const full = new Uint8Array(hash);
      const salt = full.slice(0, 12);
      const raw = await crypto.subtle.importKey('raw', enc.encode(state.roomPub), 'HKDF', false, ['deriveKey']);
      const key = await crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt, info: enc.encode('room-e2ee') }, raw, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
      return { key, salt } as { key: CryptoKey, salt: Uint8Array };
    },
    async deriveChatKey(){
      try{
        if (!(state as any).pair?.priv) return { key: null, salt: null } as { key: CryptoKey | null, salt: Uint8Array | null };
        const enc = new TextEncoder();
        const hash = await crypto.subtle.digest('SHA-256', enc.encode(state.roomPub + '|chat'));
        const full = new Uint8Array(hash);
        const salt = full.slice(0, 12);
        const raw = await crypto.subtle.importKey('raw', enc.encode((state as any).pair.priv), 'HKDF', false, ['deriveKey']);
        const key = await crypto.subtle.deriveKey({ name:'HKDF', hash:'SHA-256', salt, info: enc.encode('chat-e2ee') }, raw, { name:'AES-GCM', length:256 }, false, ['encrypt','decrypt']);
        return { key, salt } as { key: CryptoKey, salt: Uint8Array };
      }catch(e: any){ state.addLog('deriveChatKey error: '+(e?.message||e)); return { key: null, salt: null } }
    },
    ivFrom(ts: number, salt: Uint8Array){
      const iv = new Uint8Array(12);
      const view = new DataView(iv.buffer);
      view.setBigUint64(0, BigInt(ts ?? 0));
      iv.set(salt.slice(0, 4), 8);
      return iv;
    },
    async applySenderE2EE(sender: RTCRtpSender, key: CryptoKey, salt: Uint8Array){
      try{
        if (!state.enableE2EE) return;
        const anySender: any = sender as any;
        if (anySender.createEncodedStreams) {
          const { readable, writable } = anySender.createEncodedStreams();
          const transform = new TransformStream({
            async transform(chunk: any, controller: any){
              try{
                const iv = state.ivFrom(chunk.timestamp, salt);
                chunk.data = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, chunk.data));
              }catch(_e){}
              controller.enqueue(chunk);
            }
          });
          (readable as ReadableStream).pipeThrough(transform as any).pipeTo(writable as any);
        } else if ('transform' in (RTCRtpSender.prototype as any)) {
          (anySender as any).transform = new TransformStream({
            async transform(chunk: any, controller: any){
              try{
                const iv = state.ivFrom(chunk.timestamp, salt);
                const buf = new Uint8Array(chunk.data);
                const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, buf);
                chunk.data = new Uint8Array(ct);
              }catch(_e){}
              controller.enqueue(chunk);
            }
          });
        }
      }catch(e: any){ state.addLog('发送端 E2EE 未应用：'+(e?.message||e)); }
    },
    async applyReceiverE2EE(receiver: RTCRtpReceiver, key: CryptoKey, salt: Uint8Array){
      try{
        if (!state.enableE2EE) return;
        const anyReceiver: any = receiver as any;
        if (anyReceiver?.createEncodedStreams) {
          const { readable, writable } = anyReceiver.createEncodedStreams();
          const transform = new TransformStream({
            async transform(chunk: any, controller: any){
              try{
                const iv = state.ivFrom(chunk.timestamp, salt);
                const data = new Uint8Array(chunk.data);
                const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, data);
                chunk.data = new Uint8Array(pt);
                controller.enqueue(chunk);
              }catch(_e){ controller.enqueue(chunk); }
            }
          });
          (readable as ReadableStream).pipeThrough(transform as any).pipeTo(writable as any);
        } else if (anyReceiver && 'transform' in (RTCRtpReceiver.prototype as any)) {
          (anyReceiver as any).transform = new TransformStream({
            async transform(chunk: any, controller: any){
              try{
                const iv = state.ivFrom(chunk.timestamp, salt);
                const data = new Uint8Array(chunk.data);
                const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, key, data);
                chunk.data = new Uint8Array(pt);
              }catch(_e){}
              controller.enqueue(chunk);
            }
          });
        }
      }catch(e: any){ state.addLog('接收端 E2EE 未应用：'+(e?.message||e)); }
    },

    newPC(id: string){
      const cfg: RTCConfiguration = { iceServers: (state.iceServers && state.iceServers.length ? state.iceServers : [ { urls: 'stun:stun.l.google.com:19302' } ]) };
      const pc = new RTCPeerConnection(cfg);
      state.peers[id] = pc;
      pc.onicecandidate = ev => { if (ev.candidate && state.socket) { state.addLog(`ICE => 发送候选到 ${id}`); state.socket.emit('signal', { type:'candidate', data: ev.candidate, to: id }); } };
      pc.oniceconnectionstatechange = ()=> state.addLog(`节点 ${id} ICE 状态 ${pc.iceConnectionState}`);
      pc.onconnectionstatechange = ()=> state.addLog(`节点 ${id} 连接状态 ${pc.connectionState}`);
      pc.ontrack = async (ev)=>{
        try {
          const receiver = (ev as any).receiver || ((ev as any).transceiver && (ev as any).transceiver.receiver);
          if (receiver && state.e2eeKey && state.e2eeSalt) {
            await state.applyReceiverE2EE(receiver, state.e2eeKey, state.e2eeSalt);
          }
        } catch (e: any) {
          state.addLog('接收端 E2EE（ontrack）错误：'+(e?.message||e));
        }
        const stream = (ev.streams && ev.streams[0]) || new MediaStream([ev.track]);
        state.remoteStreams[id] = stream;
        if (!state.remotePeers.includes(id)) state.remotePeers.push(id);
        await nextTick();
        const elId = `remote-${id}`;
        const el = document.getElementById(elId) as HTMLVideoElement | null;
        if (el) { el.srcObject = stream; el.play().catch(()=>{}); }
      };
      return pc;
    },

    async start(){
      try{
        state.loadPair();
        if (!state.hasPrivate) { alert('need_full_keypair'); return; }

        await state.enumerate();
        await state.getLocalStream();

        // fetch ICE config from server
        try {
          const res = await fetch('/ice');
          const data = await res.json();
          state.iceServers = Array.isArray(data.iceServers) ? data.iceServers : [];
          if (data.signaling && (data.signaling.localOrigin || data.signaling.currentOrigin)) {
            state.addLog('信令地址建议：'+JSON.stringify(data.signaling));
          }
          const suggested = (data.signaling && (data.signaling.localOrigin || data.signaling.currentOrigin)) || window.location.origin;
          if (state.manualSignalingEnabled && state.manualSignalingUrl) {
            state.signalingOrigin = state.manualSignalingUrl;
            state.addLog('使用手动信令：' + state.signalingOrigin);
          } else {
            state.signalingOrigin = suggested;
          }
          state.addLog('ICE 已加载：'+JSON.stringify(state.iceServers));
        } catch(e: any) {
          state.addLog('ICE 加载失败，使用回退：'+(e?.message||e));
          if (state.manualSignalingEnabled && state.manualSignalingUrl) {
            state.signalingOrigin = state.manualSignalingUrl;
            state.addLog('使用手动信令（无 /ice）：' + state.signalingOrigin);
          } else {
            state.signalingOrigin = window.location.origin;
          }
        }

        // derive room and chat keys
        const { key, salt } = await state.deriveRoomKey();
        state.e2eeKey = key; state.e2eeSalt = salt;
        const ck = await state.deriveChatKey();
        state.chatKey = ck.key; state.chatSalt = ck.salt;

        // connect socket and auth
        const origin = state.signalingOrigin || window.location.origin;
        state.socket = io(origin, { path: '/socket.io' });

        state.socket.on('connect', ()=> state.addLog('Socket 已连接'));
        state.socket.on('connect_error', (err: any)=>{ state.addLog('Socket 连接错误：'+(err?.message||err)); });
        state.socket.on('error', (err: any)=>{ state.addLog('Socket 错误：'+(err?.message||err)); });
        state.socket.on('disconnect', (reason: string)=> state.addLog('Socket 已断开：'+reason));
        state.socket.on('auth_error', (e: any)=>{ state.addLog('认证错误：'+(e?.message||'')); alert('认证失败'); state.connected=false; });

        // Chat events
        state.socket.on('chat', async (msg: any)=>{
          try{
            const { from } = msg || {};
            if (msg && typeof msg.ct === 'string' && typeof msg.iv === 'string') {
              let text = '';
              try{
                if (state.chatKey) {
                  const iv = state.b64decode(msg.iv);
                  const ct = state.b64decode(msg.ct);
                  const pt = await crypto.subtle.decrypt({ name:'AES-GCM', iv }, state.chatKey, ct);
                  text = new TextDecoder().decode(pt);
                } else {
                  text = '[encrypted]';
                }
              }catch(_e){ text = '[encrypted]'; }
              const ts = (typeof msg.ts === 'number' && isFinite(msg.ts)) ? msg.ts : Date.now();
              state.addLog('聊天接收：'+JSON.stringify({ from, 加密:true, ts, 文本长度: text.length }));
              state.chatMessages.push({ from, text, ts });
              if (state.onChatMessage) state.onChatMessage({ from, text, ts });
              if (state.chatMessages.length > 200) state.chatMessages.shift();
              return;
            }
            const ts = (typeof msg?.ts === 'number' && isFinite(msg.ts)) ? msg.ts : Date.now();
            const text = (typeof msg?.text === 'string') ? msg.text : (msg?.text != null ? String(msg.text) : '');
            state.addLog('聊天接收：'+JSON.stringify({ from, 加密:false, ts, 文本长度: (typeof text==='string'?text.length:undefined) }));
            state.chatMessages.push({ from, text, ts });
            if (state.onChatMessage) state.onChatMessage({ from, text, ts });
            if (state.chatMessages.length > 200) state.chatMessages.shift();
          }catch(e: any){ state.addLog('聊天处理错误：'+(e?.message||e)); }
        });

        state.socket.on('challenge', async ({ id, text }: { id: string; text: string })=>{
          const signature = await unsea.signMessage(text, (state as any).pair.priv);
          state.socket!.emit('auth', { roomPub: state.roomPub, signature, challengeId: id });
        });

        state.socket.on('auth_ok', async ({ roomPub, peers, self, others }: any)=>{
          state.addLog(`认证通过，作为 ${self}，房间 ${roomPub}，在线节点 ${peers}`);
          state.connected = true; state.selfId = self; state.others = others || [];
          // 初始在线节点也触发 onPeerJoined，便于页面层补齐成员
          try { if (state.onPeerJoined) for (const pid of state.others) state.onPeerJoined({ id: pid }); } catch(_){}
          for(const pid of state.others){ await state.call(pid, state.e2eeKey!, state.e2eeSalt!); }
        });

        state.socket.on('peer-joined', async ({ id }: { id: string })=>{
          if (id === state.selfId) return;
          state.addLog(`节点加入：${id}`);
          if (!state.others.includes(id)) state.others.push(id);
          try { state.onPeerJoined && state.onPeerJoined({ id }); } catch(_){}
        });

        state.socket.on('peer-left', ({ id }: { id: string })=>{
          state.addLog(`节点离开：${id}`);
          delete state.peers[id];
          delete state.remoteStreams[id];
          state.remotePeers = state.remotePeers.filter(p=>p!==id);
          state.others = state.others.filter(p=>p!==id);
          try { state.onPeerLeft && state.onPeerLeft({ id }); } catch(_){}
        });

        state.socket.on('signal', async ({ from, type, data }: any)=>{
          let pc = state.peers[from];
          if (!pc) pc = state.newPC(from);

          if (type === 'offer'){
            await pc.setRemoteDescription(new RTCSessionDescription(data));
            state.localStream!.getTracks().forEach(t=> pc.addTrack(t, state.localStream!));
            if (state.enableE2EE) {
              for(const sender of pc.getSenders()){
                if (sender.track) await state.applySenderE2EE(sender, state.e2eeKey!, state.e2eeSalt!);
              }
            }
            const ans = await pc.createAnswer();
            await pc.setLocalDescription(ans);
            state.socket!.emit('signal', { type:'answer', data: pc.localDescription, to: from });
          } else if (type === 'answer'){
            await pc.setRemoteDescription(new RTCSessionDescription(data));
          } else if (type === 'candidate'){
            try { await pc.addIceCandidate(data); } catch(e: any) { state.addLog('添加 ICE 候选失败：'+(e?.message||e)); }
          }
        });

        state.socket.emit('get_challenge');
        state.addLog('已请求认证挑战');

      }catch(e: any){
        console.error(e); state.addLog('启动失败：'+(e?.message||e));
      }
    },

    async call(id: string, key: CryptoKey, salt: Uint8Array){
      let pc = state.peers[id];
      if (!pc) pc = state.newPC(id);
      state.localStream!.getTracks().forEach(t=> pc.addTrack(t, state.localStream!));
      if (state.enableE2EE) {
        for(const sender of pc.getSenders()){
          if (sender.track) await state.applySenderE2EE(sender, key, salt);
        }
      }
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      state.socket!.emit('signal', { type:'offer', data: pc.localDescription, to: id });
    },

    stop(){
      try{
        Object.values(state.peers).forEach(pc=>{ try{ pc.close(); }catch(_e){} });
        state.peers = {} as Record<string, RTCPeerConnection>;
        state.remoteStreams = {} as Record<string, MediaStream>;
        state.remotePeers = [] as string[];
        if (state.localStream){ state.localStream.getTracks().forEach(t=> t.stop()); }
        state.localStream = null;
        const lv = document.getElementById('localVideo') as HTMLVideoElement | null; if (lv) lv.srcObject = null;
        if (state.socket){ try{ state.socket.disconnect(); }catch(_e){} }
        state.connected = false; state.selfId = ''; state.others = [] as string[];
        state.addLog('已停止');
        state.chatMessages = [];
        state.chatKey = null; state.chatSalt = null;
      }catch(e: any){ state.addLog('停止时发生错误：'+(e?.message||e)); }
    }
  });

  state.socket?.on?.('chat', async (msg: any)=>{}); // placeholder to avoid TS removal

  onMounted(()=>{
    state.updateQRCode();
    state.enumerate().catch(()=>{});
  });

  return state;
}
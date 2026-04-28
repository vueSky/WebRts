// ============ Constants ============

const PAGE_SIZE = 9;

const ICE_CONFIG = {
  iceServers: [
    { urls: ['stun:stun.l.google.com:19302', 'stun:stun1.l.google.com:19302'] },
    { urls: 'stun:stun.cloudflare.com:3478' }
  ],
  iceCandidatePoolSize: 10,
  bundlePolicy: 'max-bundle',
  rtcpMuxPolicy: 'require'
};

// Video bitrate targets per participant count
const BITRATE_TABLE = [
  { minPeers: 16, video: 80_000,    audio: 20_000 },
  { minPeers: 10, video: 180_000,   audio: 24_000 },
  { minPeers: 6,  video: 400_000,   audio: 32_000 },
  { minPeers: 0,  video: 1_200_000, audio: 64_000 }
];

// Video capture constraints per participant count
const VIDEO_CONSTRAINTS_TABLE = [
  { minPeers: 15, constraints: { width: 320,  height: 240,  frameRate: 8  } },
  { minPeers: 8,  constraints: { width: 640,  height: 360,  frameRate: 15 } },
  { minPeers: 0,  constraints: { width: 1280, height: 720,  frameRate: 24 } }
];

// ============ State ============

const state = {
  userId: null,
  roomId: null,
  hostId: null,
  members: [],
  mutedAll: false,
  locked: false,
  localStream: null,
  screenStream: null,
  mediaRecorder: null,
  recordedChunks: [],
  peers: new Map(),
  remoteStreams: new Map(),
  pendingCandidates: new Map(),
  handRaised: false,
  isRecording: false,
  layout: 'grid',
  myMicOn: false,
  myCameraOn: false,
  myScreenSharing: false,
  _restoreScreen: null,
  _toastTimer: null,
  videoPage: 0
};

// ============ DOM refs ============

const els = {
  lobby: document.getElementById('lobby'),
  room: document.getElementById('room'),
  nameInput: document.getElementById('nameInput'),
  roomInput: document.getElementById('roomInput'),
  roomType: document.getElementById('roomType'),
  joinBtn: document.getElementById('joinBtn'),
  lobbyError: document.getElementById('lobbyError'),
  topbarRoomId: document.getElementById('topbarRoomId'),
  topbarHost: document.getElementById('topbarHost'),
  pillLocked: document.getElementById('pillLocked'),
  pillMuted: document.getElementById('pillMuted'),
  networkHint: document.getElementById('networkHint'),
  leaveBtn: document.getElementById('leaveBtn'),
  members: document.getElementById('members'),
  memberCount: document.getElementById('memberCount'),
  videoGrid: document.getElementById('videoGrid'),
  videoPageControls: document.getElementById('videoPageControls'),
  prevPageBtn: document.getElementById('prevPageBtn'),
  nextPageBtn: document.getElementById('nextPageBtn'),
  pageLabel: document.getElementById('pageLabel'),
  tabChat: document.getElementById('tabChat'),
  tabHost: document.getElementById('tabHost'),
  chatBox: document.getElementById('chatBox'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  lockBtn: document.getElementById('lockBtn'),
  lockBtnLabel: document.getElementById('lockBtnLabel'),
  muteAllBtn: document.getElementById('muteAllBtn'),
  micBtn: document.getElementById('micBtn'),
  micIcon: document.getElementById('micIcon'),
  camBtn: document.getElementById('camBtn'),
  camIcon: document.getElementById('camIcon'),
  shareBtn: document.getElementById('shareBtn'),
  recordBtn: document.getElementById('recordBtn'),
  raiseBtn: document.getElementById('raiseBtn'),
  reactionLike: document.getElementById('reactionLike'),
  reactionLaugh: document.getElementById('reactionLaugh'),
  reactionFire: document.getElementById('reactionFire'),
  toast: document.getElementById('toast')
};

// ============ WebSocket / Reconnect ============

let ws = null;
let _reconnectTimer = null;
let _reconnectDelay = 1000;
let _inRoom = false;
const _joinParams = { roomId: null, name: null, roomType: null };

function initWS() {
  clearTimeout(_reconnectTimer);
  const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProtocol}//${location.host}`);

  ws.onopen = () => {
    _reconnectDelay = 1000;
    if (_inRoom && _joinParams.roomId) {
      showToast('已重连，正在重新加入房间...');
      for (const pc of state.peers.values()) { try { pc.close(); } catch {} }
      state.peers.clear();
      state.remoteStreams.clear();
      state.pendingCandidates.clear();
      state.videoPage = 0;
      renderVideos();
      safeSend({
        type: 'create_or_join_room',
        roomId: _joinParams.roomId,
        name: _joinParams.name,
        roomType: _joinParams.roomType
      });
    }
  };

  ws.onmessage = handleMessage;

  ws.onclose = () => {
    if (_inRoom) {
      const delay = _reconnectDelay;
      _reconnectDelay = Math.min(delay * 2, 30000);
      showToast(`连接断开，${Math.round(delay / 1000)}s 后自动重连…`, delay + 500);
      els.networkHint.textContent = '网络: 重连中';
      els.networkHint.className = 'net-hint quality-poor';
      _reconnectTimer = setTimeout(initWS, delay);
    }
  };

  ws.onerror = () => {};
}

function safeSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

// ============ Utilities ============

function escapeHtml(s) {
  return String(s).replace(/[<>&"']/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' }[c]));
}

function initials(name) {
  const trimmed = (name || '?').trim();
  if (!trimmed) return '?';
  const ch = trimmed.charAt(0);
  return /[a-zA-Z]/.test(ch) ? ch.toUpperCase() : ch;
}

function showToast(text, ms = 2500) {
  els.toast.textContent = text;
  els.toast.classList.remove('hidden');
  clearTimeout(state._toastTimer);
  state._toastTimer = setTimeout(() => els.toast.classList.add('hidden'), ms);
}

function addChatLine(text, kind = 'system', from = null) {
  const div = document.createElement('div');
  div.className = `chat-line ${kind === 'system' ? 'system' : ''}`;
  if (from && kind !== 'system') {
    div.innerHTML = `<span class="from">${escapeHtml(from)}:</span>${escapeHtml(text)}`;
  } else {
    div.textContent = text;
  }
  els.chatBox.appendChild(div);
  els.chatBox.scrollTop = els.chatBox.scrollHeight;
}

function getDisplayName(userId) {
  const u = state.members.find((m) => m.userId === userId);
  return u ? u.name : (userId ? userId.slice(0, 6) : '—');
}

// ============ Lobby ============

function validateLobby() {
  const name = els.nameInput.value.trim();
  const room = els.roomInput.value.trim();
  els.joinBtn.disabled = !(name && room);
  els.lobbyError.textContent = '';
}

async function joinRoom() {
  const roomId = els.roomInput.value.trim();
  const name = els.nameInput.value.trim();
  if (!roomId || !name) {
    els.lobbyError.textContent = '请填写昵称和房间号';
    return;
  }

  els.joinBtn.disabled = true;
  els.lobbyError.textContent = '';

  try {
    await initLocalMedia();
  } catch (err) {
    els.lobbyError.textContent = `无法获取摄像头/麦克风 — ${err.name || ''}: ${err.message || err}`;
    els.joinBtn.disabled = false;
    return;
  }

  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (audioTrack) audioTrack.enabled = false;
  if (videoTrack) videoTrack.enabled = false;
  state.myMicOn = false;
  state.myCameraOn = false;

  safeSend({ type: 'create_or_join_room', roomId, name, roomType: els.roomType.value });
}

function leaveRoom() {
  _inRoom = false;
  _joinParams.roomId = null;
  clearTimeout(_reconnectTimer);
  stopTracks(state.localStream);
  stopTracks(state.screenStream);
  for (const pc of state.peers.values()) { try { pc.close(); } catch {} }
  try { ws && ws.close(); } catch {}
  location.reload();
}

// ============ Media ============

async function initLocalMedia() {
  if (state.localStream) return;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 24 } }
    });
  } catch {
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  }
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

// ============ Adaptive media quality ============

function getTargetBitrates() {
  const peerCount = state.peers.size;
  return BITRATE_TABLE.find((row) => peerCount >= row.minPeers) || BITRATE_TABLE[BITRATE_TABLE.length - 1];
}

async function applyAdaptiveBitrate(pc) {
  const rates = getTargetBitrates();
  for (const sender of pc.getSenders()) {
    if (!sender.track) continue;
    const maxBitrate = sender.track.kind === 'video' ? rates.video : rates.audio;
    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) params.encodings = [{}];
    params.encodings[0].maxBitrate = maxBitrate;
    try { await sender.setParameters(params); } catch {}
  }
}

async function applyAdaptiveBitrateAll() {
  for (const pc of state.peers.values()) {
    if (pc.connectionState === 'connected') await applyAdaptiveBitrate(pc);
  }
}

async function applyAdaptiveVideoConstraints() {
  const peerCount = state.peers.size;
  const track = state.localStream && state.localStream.getVideoTracks()[0];
  if (!track || !state.myCameraOn) return;
  const row = VIDEO_CONSTRAINTS_TABLE.find((r) => peerCount >= r.minPeers) || VIDEO_CONSTRAINTS_TABLE[VIDEO_CONSTRAINTS_TABLE.length - 1];
  try { await track.applyConstraints(row.constraints); } catch {}
}

// ============ Rendering ============

function renderMembers() {
  els.members.innerHTML = '';
  els.memberCount.textContent = state.members.length;

  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member-item';

    const row = document.createElement('div');
    row.className = 'member-row';

    const avatar = document.createElement('div');
    avatar.className = 'member-avatar';
    avatar.textContent = initials(m.name);

    const nameEl = document.createElement('div');
    nameEl.className = 'member-name';
    nameEl.textContent = m.name + (m.userId === state.userId ? ' (我)' : '');

    const flags = document.createElement('div');
    flags.className = 'member-flags';
    if (m.isHost) flags.appendChild(mflag('host', 'i-crown', '主持人'));
    if (!m.micOn) flags.appendChild(mflag('mic-off', 'i-mic-off', '已静音'));
    if (!m.cameraOn) flags.appendChild(mflag('cam-off', 'i-cam-off', '摄像头关闭'));
    if (m.screenSharing) flags.appendChild(mflag('sharing', 'i-screen', '正在共享'));
    if (m.handRaised) flags.appendChild(mflag('hand', 'i-hand', '举手'));

    row.appendChild(avatar);
    row.appendChild(nameEl);
    row.appendChild(flags);
    li.appendChild(row);

    if (state.hostId === state.userId && m.userId !== state.userId) {
      const actions = document.createElement('div');
      actions.className = 'host-actions';
      const btns = [
        ['设主持', 'host_set', false],
        ['静音', 'mute', false],
        ['关摄像', 'camera_off', false],
        ['移除', 'kick', true],
        ['拉黑', 'ban', true]
      ];
      btns.forEach(([label, action, danger]) => {
        const b = document.createElement('button');
        b.textContent = label;
        if (danger) b.className = 'danger';
        b.onclick = () => {
          if (action === 'host_set') safeSend({ type: 'host_set', targetId: m.userId });
          else safeSend({ type: 'member_control', targetId: m.userId, action });
        };
        actions.appendChild(b);
      });
      li.appendChild(actions);
    }

    els.members.appendChild(li);
  }
}

function mflag(cls, iconId, title) {
  const span = document.createElement('span');
  span.className = `mflag ${cls}`;
  span.title = title;
  span.innerHTML = `<svg class="ico-sm"><use href="#${iconId}"/></svg>`;
  return span;
}

// ---- Video grid with pagination ----

function getPagedParticipants() {
  const all = [];
  if (state.localStream) all.push({ isLocal: true });
  for (const [userId, stream] of state.remoteStreams.entries()) {
    all.push({ isLocal: false, userId, stream });
  }

  const total = all.length;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  state.videoPage = Math.max(0, Math.min(state.videoPage, totalPages - 1));

  return {
    items: all.slice(state.videoPage * PAGE_SIZE, (state.videoPage + 1) * PAGE_SIZE),
    total,
    totalPages,
    currentPage: state.videoPage
  };
}

function updatePageControls({ total, totalPages, currentPage }) {
  if (!els.videoPageControls) return;
  if (totalPages <= 1) {
    els.videoPageControls.classList.add('hidden');
    return;
  }
  els.videoPageControls.classList.remove('hidden');
  els.pageLabel.textContent = `${currentPage + 1} / ${totalPages}`;
  els.prevPageBtn.disabled = currentPage === 0;
  els.nextPageBtn.disabled = currentPage === totalPages - 1;
}

function renderVideos() {
  els.videoGrid.className = `video-grid ${state.layout === 'grid' ? '' : state.layout}`.trim();
  els.videoGrid.innerHTML = '';

  const paged = getPagedParticipants();
  updatePageControls(paged);

  for (const item of paged.items) {
    if (item.isLocal) {
      const useStream = state.screenStream || state.localStream;
      const tile = createTile({
        stream: useStream,
        name: els.nameInput.value.trim() || '我',
        muted: true,
        isLocal: true,
        isHost: state.hostId === state.userId,
        micOn: state.myMicOn,
        cameraOn: state.screenStream ? true : state.myCameraOn,
        screenSharing: !!state.screenStream
      });
      if (state.layout !== 'grid') tile.classList.add('speaker-main');
      els.videoGrid.appendChild(tile);
    } else {
      const m = state.members.find((mem) => mem.userId === item.userId);
      const tile = createTile({
        stream: item.stream,
        name: m ? m.name : item.userId.slice(0, 6),
        muted: false,
        isLocal: false,
        isHost: state.hostId === item.userId,
        micOn: m ? m.micOn : true,
        cameraOn: m ? m.cameraOn : true,
        screenSharing: m ? !!m.screenSharing : false
      });
      els.videoGrid.appendChild(tile);
    }
  }
}

function createTile({ stream, name, muted, isLocal, isHost, micOn, cameraOn, screenSharing }) {
  const tile = document.createElement('div');
  tile.className = 'tile';
  if (screenSharing) tile.classList.add('is-sharing');
  if (!cameraOn && !screenSharing) tile.classList.add('cam-off');

  const v = document.createElement('video');
  v.srcObject = stream;
  v.autoplay = true;
  v.playsInline = true;
  if (muted) v.muted = true;
  tile.appendChild(v);

  const placeholder = document.createElement('div');
  placeholder.className = 'tile-placeholder';
  placeholder.textContent = initials(name);
  tile.appendChild(placeholder);

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';

  if (screenSharing) {
    const badge = document.createElement('div');
    badge.className = 'tile-badge';
    badge.innerHTML = `<span class="dot"></span>${isLocal ? '你正在共享屏幕' : '正在共享屏幕'}`;
    overlay.appendChild(badge);
  }

  const label = document.createElement('div');
  label.className = 'tile-label';
  let html = '';
  if (isHost) html += `<svg class="ico-sm" style="color:#f59e0b"><use href="#i-crown"/></svg>`;
  html += `<span>${escapeHtml(name)}${isLocal ? ' (我)' : ''}</span>`;
  if (!micOn) html += `<span class="lmic"><svg class="ico-sm"><use href="#i-mic-off"/></svg></span>`;
  label.innerHTML = html;
  overlay.appendChild(label);

  tile.appendChild(overlay);
  return tile;
}

function updateRoomMeta() {
  if (!state.roomId) return;
  els.topbarRoomId.textContent = state.roomId;
  els.topbarHost.textContent = getDisplayName(state.hostId);
  els.pillLocked.classList.toggle('hidden', !state.locked);
  els.pillMuted.classList.toggle('hidden', !state.mutedAll);

  const isHost = state.hostId === state.userId;
  const hostTab = document.querySelector('.tab[data-tab="host"]');
  if (hostTab) hostTab.classList.toggle('hidden', !isHost);
  if (!isHost && els.tabHost && !els.tabHost.classList.contains('hidden')) switchTab('chat');
  if (els.lockBtnLabel) els.lockBtnLabel.textContent = state.locked ? '解锁房间' : '锁定房间';
}

function updateMediaButtons() {
  const setDock = (btn, on, iconOn, iconOff, labelOn, labelOff, iconEl) => {
    btn.classList.toggle('on', on);
    btn.classList.toggle('off', !on);
    if (iconEl) iconEl.setAttribute('href', on ? `#${iconOn}` : `#${iconOff}`);
    const labelEl = btn.querySelector('.dock-label');
    if (labelEl) labelEl.textContent = on ? labelOn : labelOff;
  };

  setDock(els.micBtn, state.myMicOn, 'i-mic', 'i-mic-off', '关麦', '开麦', els.micIcon);
  setDock(els.camBtn, state.myCameraOn, 'i-cam', 'i-cam-off', '关摄像', '开摄像', els.camIcon);

  els.shareBtn.classList.toggle('active', state.myScreenSharing);
  const shareLabel = els.shareBtn.querySelector('.dock-label');
  if (shareLabel) shareLabel.textContent = state.myScreenSharing ? '停止共享' : '共享';

  els.recordBtn.classList.toggle('recording', state.isRecording);
  const recLabel = els.recordBtn.querySelector('.dock-label');
  if (recLabel) recLabel.textContent = state.isRecording ? '停止' : '录制';

  els.raiseBtn.classList.toggle('active', state.handRaised);
  const handLabel = els.raiseBtn.querySelector('.dock-label');
  if (handLabel) handLabel.textContent = state.handRaised ? '放下' : '举手';
}

// ============ Tabs & Layout ============

function switchTab(name) {
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === name));
  els.tabChat.classList.toggle('hidden', name !== 'chat');
  els.tabHost.classList.toggle('hidden', name !== 'host');
}

document.querySelectorAll('.tab').forEach((tab) => {
  tab.onclick = () => {
    if (tab.classList.contains('hidden')) return;
    switchTab(tab.dataset.tab);
  };
});

document.querySelectorAll('.seg-btn').forEach((btn) => {
  btn.onclick = () => {
    document.querySelectorAll('.seg-btn').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    state.layout = btn.dataset.layout;
    state.videoPage = 0;
    renderVideos();
  };
});

if (els.prevPageBtn) {
  els.prevPageBtn.onclick = () => {
    if (state.videoPage > 0) { state.videoPage--; renderVideos(); }
  };
}
if (els.nextPageBtn) {
  els.nextPageBtn.onclick = () => {
    state.videoPage++;
    renderVideos();
  };
}

// ============ WebRTC ============

function cleanupPeer(targetId) {
  const pc = state.peers.get(targetId);
  if (pc) { try { pc.close(); } catch {} }
  state.peers.delete(targetId);
  state.remoteStreams.delete(targetId);
  state.pendingCandidates.delete(targetId);
  renderVideos();
}

function createPeer(targetId) {
  if (state.peers.has(targetId)) return state.peers.get(targetId);

  const pc = new RTCPeerConnection(ICE_CONFIG);

  const remoteStream = new MediaStream();
  state.remoteStreams.set(targetId, remoteStream);

  pc.ontrack = (e) => {
    e.streams[0].getTracks().forEach((t) => remoteStream.addTrack(t));
    renderVideos();
  };

  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    safeSend({ type: 'signal', targetId, signal: { type: 'candidate', candidate: e.candidate } });
  };

  pc.oniceconnectionstatechange = () => {
    console.log(`[RTC ${targetId.slice(0, 6)}] ICE: ${pc.iceConnectionState}`);
  };

  pc.onconnectionstatechange = () => {
    const s = pc.connectionState;
    console.log(`[RTC ${targetId.slice(0, 6)}] Conn: ${s}`);

    if (s === 'connected') {
      applyAdaptiveBitrate(pc);
      return;
    }

    if (s === 'failed') {
      // Give 8s, then recreate if member is still present
      setTimeout(() => {
        if (!state.peers.has(targetId) || state.peers.get(targetId) !== pc) return;
        cleanupPeer(targetId);
        if (state.members.find((m) => m.userId === targetId)) makeOffer(targetId);
      }, 8000);
      return;
    }

    if (s === 'disconnected') {
      // Wait 12s — LAN drops are usually transient
      setTimeout(() => {
        if (!state.peers.has(targetId) || state.peers.get(targetId) !== pc) return;
        if (pc.connectionState === 'disconnected') {
          cleanupPeer(targetId);
          if (state.members.find((m) => m.userId === targetId)) makeOffer(targetId);
        }
      }, 12000);
      return;
    }

    if (s === 'closed') {
      cleanupPeer(targetId);
    }
  };

  const audioTrack = state.localStream && state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream && state.localStream.getVideoTracks()[0];
  if (audioTrack) pc.addTrack(audioTrack, state.localStream);
  if (videoTrack) pc.addTrack(videoTrack, state.localStream);

  state.peers.set(targetId, pc);
  return pc;
}

async function flushPendingCandidates(pc, fromId) {
  const buffered = state.pendingCandidates.get(fromId);
  if (!buffered || buffered.length === 0) return;
  for (const c of buffered) {
    try { await pc.addIceCandidate(new RTCIceCandidate(c)); } catch (err) {
      console.warn(`[RTC ${fromId.slice(0, 6)}] flush candidate:`, err);
    }
  }
  state.pendingCandidates.delete(fromId);
}

async function makeOffer(targetId) {
  const pc = createPeer(targetId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  safeSend({ type: 'signal', targetId, signal: { type: 'offer', sdp: offer } });
}

async function handleSignal(fromId, signal) {
  const pc = createPeer(fromId);

  try {
    if (signal.type === 'offer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushPendingCandidates(pc, fromId);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      safeSend({ type: 'signal', targetId: fromId, signal: { type: 'answer', sdp: answer } });
      return;
    }

    if (signal.type === 'answer') {
      await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
      await flushPendingCandidates(pc, fromId);
      return;
    }

    if (signal.type === 'candidate') {
      if (!pc.remoteDescription || !pc.remoteDescription.type) {
        if (!state.pendingCandidates.has(fromId)) state.pendingCandidates.set(fromId, []);
        state.pendingCandidates.get(fromId).push(signal.candidate);
        return;
      }
      try { await pc.addIceCandidate(new RTCIceCandidate(signal.candidate)); } catch (err) {
        console.warn(`[RTC ${fromId.slice(0, 6)}] addIceCandidate:`, err);
      }
    }
  } catch (err) {
    console.error(`[RTC ${fromId.slice(0, 6)}] handleSignal ${signal.type}:`, err);
    showToast(`信令错误: ${err.message}`);
  }
}

// ============ Network monitor ============

function monitorNetwork() {
  setInterval(async () => {
    if (!_inRoom || state.peers.size === 0) return;

    let totalRtt = 0;
    let rttCount = 0;
    let worstQuality = 'good';

    for (const pc of state.peers.values()) {
      if (pc.connectionState !== 'connected') continue;
      try {
        const stats = await pc.getStats();
        stats.forEach((r) => {
          if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
            totalRtt += r.currentRoundTripTime * 1000;
            rttCount++;
          }
          if (r.type === 'inbound-rtp' && r.packetsLost > 0 && r.packetsReceived > 0) {
            const lossRate = r.packetsLost / (r.packetsLost + r.packetsReceived);
            if (lossRate > 0.05 && worstQuality !== 'poor') worstQuality = 'poor';
            else if (lossRate > 0.02 && worstQuality === 'good') worstQuality = 'fair';
          }
        });
      } catch {}
    }

    const avgRtt = rttCount > 0 ? totalRtt / rttCount : 0;
    let quality;
    if (avgRtt > 350 || worstQuality === 'poor') quality = 'poor';
    else if (avgRtt > 150 || worstQuality === 'fair') quality = 'fair';
    else quality = 'good';

    const label = quality === 'good' ? '良好' : quality === 'fair' ? '一般' : '较差';
    const rttStr = avgRtt > 0 ? ` ${Math.round(avgRtt)}ms` : '';
    els.networkHint.textContent = `网络 ${label}${rttStr}`;
    els.networkHint.className = `net-hint quality-${quality}`;

    await applyAdaptiveVideoConstraints();
    await applyAdaptiveBitrateAll();
  }, 6000);
}

// ============ WebSocket message handler ============

async function handleMessage(ev) {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'connected') {
    state.userId = msg.userId;
    return;
  }

  if (msg.type === 'error') {
    if (els.lobby.classList.contains('hidden')) showToast(msg.message);
    else els.lobbyError.textContent = msg.message;
    els.joinBtn.disabled = false;
    return;
  }

  if (msg.type === 'joined_room') {
    _inRoom = true;
    _joinParams.roomId = msg.roomId;
    _joinParams.name = els.nameInput.value.trim();
    _joinParams.roomType = els.roomType.value;

    // Clear stale peer state (important after reconnect)
    for (const pc of state.peers.values()) { try { pc.close(); } catch {} }
    state.peers.clear();
    state.remoteStreams.clear();
    state.pendingCandidates.clear();

    state.roomId = msg.roomId;
    state.hostId = msg.hostId;
    state.locked = msg.locked;
    state.mutedAll = msg.mutedAll;
    state.members = msg.members;
    state.videoPage = 0;

    safeSend({ type: 'media_state', micOn: false, cameraOn: false, screenSharing: false });

    els.lobby.classList.add('hidden');
    els.room.classList.remove('hidden');

    updateRoomMeta();
    renderMembers();
    renderVideos();
    updateMediaButtons();

    for (const m of state.members) {
      if (m.userId !== state.userId) await makeOffer(m.userId);
    }

    // Suggest camera-off for large meetings
    if (state.members.length >= 10) {
      showToast(`${state.members.length} 人会议，建议关闭摄像头以保持稳定`, 5000);
    }

    addChatLine(`已加入房间 ${msg.roomId}`);
    return;
  }

  if (msg.type === 'member_joined') {
    state.members.push(msg.member);
    renderMembers();
    updateRoomMeta();
    addChatLine(`${msg.member.name} 加入`);

    const totalCount = state.members.length;
    if (totalCount === 10 || totalCount === 15 || totalCount === 20) {
      showToast(`当前 ${totalCount} 人，建议关闭摄像头以保持稳定`, 4000);
    }
    return;
  }

  if (msg.type === 'member_left') {
    const left = state.members.find((m) => m.userId === msg.userId);
    state.members = state.members.filter((m) => m.userId !== msg.userId);
    cleanupPeer(msg.userId);
    renderMembers();
    updateRoomMeta();
    addChatLine(`${left ? left.name : msg.userId.slice(0, 6)} 离开`);
    return;
  }

  if (msg.type === 'room_state') {
    state.hostId = msg.hostId;
    state.locked = msg.locked;
    state.mutedAll = msg.mutedAll;
    state.members = msg.members;
    updateRoomMeta();
    renderMembers();
    renderVideos();
    return;
  }

  if (msg.type === 'host_assigned') {
    state.hostId = msg.hostId;
    updateRoomMeta();
    renderMembers();
    addChatLine(`新主持人 ${getDisplayName(msg.hostId)}`);
    return;
  }

  if (msg.type === 'signal') {
    await handleSignal(msg.fromId, msg.signal);
    return;
  }

  if (msg.type === 'chat') {
    addChatLine(msg.text, 'chat', msg.name);
    return;
  }

  if (msg.type === 'reaction') {
    addChatLine(`${msg.name} ${msg.reaction}`);
    return;
  }

  if (msg.type === 'force_mute') {
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      state.myMicOn = false;
      safeSend({ type: 'media_state', micOn: false });
      updateMediaButtons();
      showToast('你被主持人静音');
    }
    return;
  }

  if (msg.type === 'force_camera_off') {
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach((t) => (t.enabled = false));
      state.myCameraOn = false;
      safeSend({ type: 'media_state', cameraOn: false });
      updateMediaButtons();
      renderVideos();
      showToast('你的摄像头被主持人关闭');
    }
    return;
  }

  if (msg.type === 'force_mute_all' && msg.value && state.localStream) {
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    state.myMicOn = false;
    safeSend({ type: 'media_state', micOn: false });
    updateMediaButtons();
    showToast('已执行全员静音');
    return;
  }

  if (msg.type === 'kicked') {
    showToast('你已被移出房间');
    _inRoom = false;
    _joinParams.roomId = null;
    clearTimeout(_reconnectTimer);
    setTimeout(() => location.reload(), 1500);
  }
}

// ============ Event bindings ============

els.nameInput.oninput = validateLobby;
els.roomInput.oninput = validateLobby;
els.nameInput.onkeydown = (e) => { if (e.key === 'Enter') els.roomInput.focus(); };
els.roomInput.onkeydown = (e) => { if (e.key === 'Enter' && !els.joinBtn.disabled) joinRoom(); };
els.joinBtn.onclick = joinRoom;
els.leaveBtn.onclick = leaveRoom;

els.micBtn.onclick = () => {
  if (!state.localStream) return;
  const a = state.localStream.getAudioTracks()[0];
  if (!a) return;
  a.enabled = !a.enabled;
  state.myMicOn = a.enabled;
  safeSend({ type: 'media_state', micOn: a.enabled });
  updateMediaButtons();
};

els.camBtn.onclick = async () => {
  if (!state.localStream) return;
  const v = state.localStream.getVideoTracks()[0];
  if (!v) return;
  v.enabled = !v.enabled;
  state.myCameraOn = v.enabled;
  if (v.enabled) await applyAdaptiveVideoConstraints();
  safeSend({ type: 'media_state', cameraOn: v.enabled });
  updateMediaButtons();
  renderVideos();
};

els.shareBtn.onclick = async () => {
  if (!navigator.mediaDevices || typeof navigator.mediaDevices.getDisplayMedia !== 'function') {
    showToast('移动端浏览器暂不支持屏幕共享，请在电脑端使用此功能', 4000);
    return;
  }
  try {
    if (!state.screenStream) {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      const screenTrack = state.screenStream.getVideoTracks()[0];

      for (const pc of state.peers.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
      }

      const restore = async () => {
        const camTrack = state.localStream && state.localStream.getVideoTracks()[0];
        for (const pc of state.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender && camTrack) await sender.replaceTrack(camTrack);
        }
        stopTracks(state.screenStream);
        state.screenStream = null;
        state.myScreenSharing = false;
        state._restoreScreen = null;
        safeSend({ type: 'media_state', screenSharing: false });
        updateMediaButtons();
        renderVideos();
      };

      screenTrack.onended = restore;
      state._restoreScreen = restore;
      state.myScreenSharing = true;
      safeSend({ type: 'media_state', screenSharing: true });
      updateMediaButtons();
      renderVideos();
      addChatLine('你开始共享屏幕');
    } else {
      if (state._restoreScreen) await state._restoreScreen();
      addChatLine('你停止了共享屏幕');
    }
  } catch (err) {
    if (err.name !== 'NotAllowedError') showToast(`共享失败: ${err.message}`);
  }
};

els.recordBtn.onclick = () => {
  if (!state.localStream) return;
  if (!state.isRecording) {
    state.recordedChunks = [];
    const src = state.screenStream || state.localStream;
    state.mediaRecorder = new MediaRecorder(src, { mimeType: 'video/webm;codecs=vp8,opus' });
    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = () => {
      const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `record-${Date.now()}.webm`;
      a.click();
      URL.revokeObjectURL(url);
    };
    state.mediaRecorder.start(1000);
    state.isRecording = true;
    showToast('本地录制已开始');
  } else {
    state.mediaRecorder.stop();
    state.isRecording = false;
    showToast('录制结束，文件开始下载');
  }
  updateMediaButtons();
};

els.raiseBtn.onclick = () => {
  state.handRaised = !state.handRaised;
  safeSend({ type: 'raise_hand', value: state.handRaised });
  updateMediaButtons();
};

els.reactionLike.onclick = () => safeSend({ type: 'reaction', reaction: '👍' });
els.reactionLaugh.onclick = () => safeSend({ type: 'reaction', reaction: '😂' });
els.reactionFire.onclick = () => safeSend({ type: 'reaction', reaction: '🔥' });

function sendChat() {
  const text = els.chatInput.value.trim();
  if (!text) return;
  safeSend({ type: 'chat', text });
  els.chatInput.value = '';
}

els.sendChatBtn.onclick = sendChat;
els.chatInput.onkeydown = (e) => { if (e.key === 'Enter') sendChat(); };
els.lockBtn.onclick = () => safeSend({ type: 'room_lock', locked: !state.locked });
els.muteAllBtn.onclick = () => safeSend({ type: 'mute_all', value: !state.mutedAll });

window.addEventListener('beforeunload', () => {
  stopTracks(state.localStream);
  stopTracks(state.screenStream);
});

// ============ Bootstrap ============

validateLobby();
monitorNetwork();
initWS();

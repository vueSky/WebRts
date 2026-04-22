const wsProtocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
const ws = new WebSocket(`${wsProtocol}//${location.host}`);

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
  audioSender: null,
  videoSender: null,
  handRaised: false,
  isRecording: false,
  layout: 'grid',
  myMicOn: false,
  myCameraOn: false,
  myScreenSharing: false,
  _restoreScreen: null,
  _toastTimer: null
};

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

function safeSend(payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

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

/* ============ Lobby ============ */

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

  safeSend({
    type: 'create_or_join_room',
    roomId,
    name,
    roomType: els.roomType.value
  });
}

function leaveRoom() {
  stopTracks(state.localStream);
  stopTracks(state.screenStream);
  for (const pc of state.peers.values()) pc.close();
  try { ws.close(); } catch {}
  location.reload();
}

/* ============ Media ============ */

async function initLocalMedia() {
  if (state.localStream) return;
  try {
    state.localStream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    });
  } catch (err) {
    console.error('[Media] getUserMedia failed:', err);
    state.localStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
  }
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

/* ============ Rendering ============ */

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

function renderVideos() {
  els.videoGrid.className = `video-grid ${state.layout === 'grid' ? '' : state.layout}`.trim();
  els.videoGrid.innerHTML = '';

  if (state.localStream) {
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
  }

  for (const [userId, stream] of state.remoteStreams.entries()) {
    const m = state.members.find((m) => m.userId === userId);
    const tile = createTile({
      stream,
      name: m ? m.name : userId.slice(0, 6),
      muted: false,
      isLocal: false,
      isHost: state.hostId === userId,
      micOn: m ? m.micOn : true,
      cameraOn: m ? m.cameraOn : true,
      screenSharing: m ? !!m.screenSharing : false
    });
    els.videoGrid.appendChild(tile);
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
  if (!isHost && els.tabHost && !els.tabHost.classList.contains('hidden')) {
    switchTab('chat');
  }

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

/* ============ Tabs & Layout ============ */

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
    renderVideos();
  };
});

/* ============ WebRTC ============ */

function createPeer(targetId) {
  if (state.peers.has(targetId)) return state.peers.get(targetId);

  const pc = new RTCPeerConnection({
    iceServers: [{ urls: 'stun:stun.l.google.com:19302' }]
  });

  const remoteStream = new MediaStream();
  state.remoteStreams.set(targetId, remoteStream);
  renderVideos();

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
    console.log(`[RTC ${targetId.slice(0, 6)}] Conn: ${pc.connectionState}`);
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      state.peers.delete(targetId);
      state.remoteStreams.delete(targetId);
      state.pendingCandidates.delete(targetId);
      renderVideos();
    }
  };

  const audioTrack = state.localStream.getAudioTracks()[0];
  const videoTrack = state.localStream.getVideoTracks()[0];
  if (audioTrack) state.audioSender = pc.addTrack(audioTrack, state.localStream);
  if (videoTrack) state.videoSender = pc.addTrack(videoTrack, state.localStream);

  state.peers.set(targetId, pc);
  return pc;
}

async function flushPendingCandidates(pc, fromId) {
  const buffered = state.pendingCandidates.get(fromId);
  if (!buffered || buffered.length === 0) return;
  for (const c of buffered) {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(c));
    } catch (err) {
      console.warn(`[RTC ${fromId.slice(0, 6)}] flush candidate failed:`, err);
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
      try {
        await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
      } catch (err) {
        console.warn(`[RTC ${fromId.slice(0, 6)}] addIceCandidate failed:`, err);
      }
    }
  } catch (err) {
    console.error(`[RTC ${fromId.slice(0, 6)}] handleSignal ${signal.type} failed:`, err);
    showToast(`信令错误: ${err.message}`);
  }
}

/* ============ Network monitor ============ */

function monitorNetwork() {
  setInterval(async () => {
    let quality = 'good';
    for (const pc of state.peers.values()) {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
          const rtt = r.currentRoundTripTime * 1000;
          if (rtt > 350) quality = 'poor';
          else if (rtt > 200 && quality !== 'poor') quality = 'fair';
        }
      });
    }

    const label = quality === 'good' ? '良好' : quality === 'fair' ? '一般' : '较差';
    els.networkHint.textContent = `网络 ${label}`;
    els.networkHint.className = `net-hint quality-${quality}`;

    const videoTrack = state.localStream && state.localStream.getVideoTracks()[0];
    if (!videoTrack || !state.myCameraOn) return;

    try {
      if (quality === 'poor') await videoTrack.applyConstraints({ width: 640, height: 360, frameRate: 15 });
      else if (quality === 'fair') await videoTrack.applyConstraints({ width: 1280, height: 720, frameRate: 20 });
    } catch {}
  }, 5000);
}

/* ============ WebSocket events ============ */

ws.onmessage = async (ev) => {
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
    state.roomId = msg.roomId;
    state.hostId = msg.hostId;
    state.locked = msg.locked;
    state.mutedAll = msg.mutedAll;
    state.members = msg.members;

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

    addChatLine(`已加入房间 ${msg.roomId}`);
    return;
  }

  if (msg.type === 'member_joined') {
    state.members.push(msg.member);
    renderMembers();
    updateRoomMeta();
    addChatLine(`${msg.member.name} 加入`);
    return;
  }

  if (msg.type === 'member_left') {
    const left = state.members.find((m) => m.userId === msg.userId);
    state.members = state.members.filter((m) => m.userId !== msg.userId);
    const pc = state.peers.get(msg.userId);
    if (pc) pc.close();
    state.peers.delete(msg.userId);
    state.remoteStreams.delete(msg.userId);
    state.pendingCandidates.delete(msg.userId);
    renderVideos();
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
    setTimeout(() => location.reload(), 1500);
  }
};

ws.onclose = () => {
  if (!els.room.classList.contains('hidden')) {
    showToast('连接已断开，正在返回首页…');
    setTimeout(() => location.reload(), 1500);
  }
};

/* ============ Event bindings ============ */

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

els.camBtn.onclick = () => {
  if (!state.localStream) return;
  const v = state.localStream.getVideoTracks()[0];
  if (!v) return;
  v.enabled = !v.enabled;
  state.myCameraOn = v.enabled;
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
    if (err.name !== 'NotAllowedError') {
      showToast(`共享失败: ${err.message}`);
    }
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

validateLobby();
monitorNetwork();

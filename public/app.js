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
  audioSender: null,
  videoSender: null,
  handRaised: false,
  isRecording: false,
  layout: 'grid'
};

const els = {
  roomMeta: document.getElementById('roomMeta'),
  members: document.getElementById('members'),
  videoGrid: document.getElementById('videoGrid'),
  chatBox: document.getElementById('chatBox'),
  roomInput: document.getElementById('roomInput'),
  nameInput: document.getElementById('nameInput'),
  roomType: document.getElementById('roomType'),
  joinBtn: document.getElementById('joinBtn'),
  micBtn: document.getElementById('micBtn'),
  camBtn: document.getElementById('camBtn'),
  shareBtn: document.getElementById('shareBtn'),
  recordBtn: document.getElementById('recordBtn'),
  raiseBtn: document.getElementById('raiseBtn'),
  reactionLike: document.getElementById('reactionLike'),
  reactionLaugh: document.getElementById('reactionLaugh'),
  reactionFire: document.getElementById('reactionFire'),
  chatInput: document.getElementById('chatInput'),
  sendChatBtn: document.getElementById('sendChatBtn'),
  lockBtn: document.getElementById('lockBtn'),
  muteAllBtn: document.getElementById('muteAllBtn'),
  layoutMode: document.getElementById('layoutMode'),
  networkHint: document.getElementById('networkHint')
};

function safeSend(payload) {
  if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function addChatLine(text) {
  const div = document.createElement('div');
  div.className = 'chat-line';
  div.textContent = text;
  els.chatBox.appendChild(div);
  els.chatBox.scrollTop = els.chatBox.scrollHeight;
}

function renderMembers() {
  els.members.innerHTML = '';
  for (const m of state.members) {
    const li = document.createElement('li');
    li.className = 'member-item';

    const status = [];
    if (m.isHost) status.push('[Host]');
    if (!m.micOn) status.push('[MicOff]');
    if (!m.cameraOn) status.push('[CamOff]');
    if (m.handRaised) status.push('[Hand]');

    li.textContent = `${m.name} ${status.join(' ')}`;

    if (state.hostId === state.userId && m.userId !== state.userId) {
      const actions = document.createElement('div');
      actions.style.marginTop = '6px';
      actions.style.display = 'flex';
      actions.style.gap = '6px';
      actions.style.flexWrap = 'wrap';

      const btns = [
        ['设主持', 'host_set'],
        ['静音', 'mute'],
        ['关摄像', 'camera_off'],
        ['移除', 'kick'],
        ['拉黑', 'ban']
      ];

      btns.forEach(([label, action]) => {
        const b = document.createElement('button');
        b.textContent = label;
        b.onclick = () => {
          if (action === 'host_set') {
            safeSend({ type: 'host_set', targetId: m.userId });
          } else {
            safeSend({ type: 'member_control', targetId: m.userId, action });
          }
        };
        actions.appendChild(b);
      });

      li.appendChild(actions);
    }

    els.members.appendChild(li);
  }
}

function getDisplayName(userId) {
  const user = state.members.find((m) => m.userId === userId);
  return user ? user.name : userId.slice(0, 6);
}

function renderVideos() {
  els.videoGrid.className = `video-grid ${state.layout === 'grid' ? '' : state.layout}`.trim();
  els.videoGrid.innerHTML = '';

  if (state.localStream) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const v = document.createElement('video');
    v.srcObject = state.localStream;
    v.muted = true;
    v.autoplay = true;
    v.playsInline = true;
    tile.appendChild(v);
    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = '我';
    tile.appendChild(label);
    if (state.layout !== 'grid') tile.classList.add('speaker-main');
    els.videoGrid.appendChild(tile);
  }

  for (const [userId, stream] of state.remoteStreams.entries()) {
    const tile = document.createElement('div');
    tile.className = 'tile';
    const v = document.createElement('video');
    v.srcObject = stream;
    v.autoplay = true;
    v.playsInline = true;
    tile.appendChild(v);
    const label = document.createElement('div');
    label.className = 'tile-label';
    label.textContent = getDisplayName(userId);
    tile.appendChild(label);
    els.videoGrid.appendChild(tile);
  }
}

function updateRoomMeta() {
  if (!state.roomId) {
    els.roomMeta.textContent = '未加入房间';
    return;
  }
  const hostName = getDisplayName(state.hostId);
  els.roomMeta.textContent = `房间: ${state.roomId} | Host: ${hostName} | 锁定: ${state.locked ? '是' : '否'} | 全员静音: ${state.mutedAll ? '是' : '否'}`;
}

async function initLocalMedia() {
  if (state.localStream) return;
  state.localStream = await navigator.mediaDevices.getUserMedia({
    audio: true,
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } }
  });
  renderVideos();
}

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

  pc.onconnectionstatechange = () => {
    if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
      state.peers.delete(targetId);
      state.remoteStreams.delete(targetId);
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

async function makeOffer(targetId) {
  const pc = createPeer(targetId);
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  safeSend({ type: 'signal', targetId, signal: { type: 'offer', sdp: offer } });
}

async function handleSignal(fromId, signal) {
  const pc = createPeer(fromId);

  if (signal.type === 'offer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    const answer = await pc.createAnswer();
    await pc.setLocalDescription(answer);
    safeSend({ type: 'signal', targetId: fromId, signal: { type: 'answer', sdp: answer } });
    return;
  }

  if (signal.type === 'answer') {
    await pc.setRemoteDescription(new RTCSessionDescription(signal.sdp));
    return;
  }

  if (signal.type === 'candidate') {
    try {
      await pc.addIceCandidate(new RTCIceCandidate(signal.candidate));
    } catch {
      // ignore out-of-order candidates
    }
  }
}

async function joinRoom() {
  const roomId = els.roomInput.value.trim();
  const name = els.nameInput.value.trim();
  if (!roomId) {
    addChatLine('请输入房间 ID');
    return;
  }

  await initLocalMedia();
  safeSend({ type: 'create_or_join_room', roomId, name, roomType: els.roomType.value });
}

function stopTracks(stream) {
  if (!stream) return;
  stream.getTracks().forEach((t) => t.stop());
}

function downloadRecording() {
  const blob = new Blob(state.recordedChunks, { type: 'video/webm' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `record-${Date.now()}.webm`;
  a.click();
  URL.revokeObjectURL(url);
}

function monitorNetwork() {
  setInterval(async () => {
    let quality = '良好';
    for (const pc of state.peers.values()) {
      const stats = await pc.getStats();
      stats.forEach((r) => {
        if (r.type === 'candidate-pair' && r.state === 'succeeded' && r.currentRoundTripTime) {
          const rtt = r.currentRoundTripTime * 1000;
          if (rtt > 350) quality = '较差';
          else if (rtt > 200) quality = '一般';
        }
      });
    }

    els.networkHint.textContent = `网络: ${quality}`;

    const videoTrack = state.localStream && state.localStream.getVideoTracks()[0];
    if (!videoTrack) return;

    if (quality === '较差') {
      await videoTrack.applyConstraints({ width: 640, height: 360, frameRate: 15 });
    } else if (quality === '一般') {
      await videoTrack.applyConstraints({ width: 1280, height: 720, frameRate: 20 });
    } else {
      await videoTrack.applyConstraints({ width: 1920, height: 1080, frameRate: 30 });
    }
  }, 5000);
}

ws.onmessage = async (ev) => {
  const msg = JSON.parse(ev.data);

  if (msg.type === 'connected') {
    state.userId = msg.userId;
    return;
  }

  if (msg.type === 'error') {
    addChatLine(`系统: ${msg.message}`);
    return;
  }

  if (msg.type === 'joined_room') {
    state.roomId = msg.roomId;
    state.hostId = msg.hostId;
    state.locked = msg.locked;
    state.mutedAll = msg.mutedAll;
    state.members = msg.members;
    updateRoomMeta();
    renderMembers();

    for (const m of state.members) {
      if (m.userId !== state.userId) await makeOffer(m.userId);
    }

    addChatLine(`系统: 已加入房间 ${msg.roomId}`);
    return;
  }

  if (msg.type === 'member_joined') {
    state.members.push(msg.member);
    renderMembers();
    updateRoomMeta();
    addChatLine(`系统: ${msg.member.name} 加入`);
    return;
  }

  if (msg.type === 'member_left') {
    state.members = state.members.filter((m) => m.userId !== msg.userId);
    const pc = state.peers.get(msg.userId);
    if (pc) pc.close();
    state.peers.delete(msg.userId);
    state.remoteStreams.delete(msg.userId);
    renderVideos();
    renderMembers();
    updateRoomMeta();
    addChatLine(`系统: ${msg.userId.slice(0, 6)} 离开`);
    return;
  }

  if (msg.type === 'room_state') {
    state.hostId = msg.hostId;
    state.locked = msg.locked;
    state.mutedAll = msg.mutedAll;
    state.members = msg.members;
    updateRoomMeta();
    renderMembers();
    return;
  }

  if (msg.type === 'host_assigned') {
    state.hostId = msg.hostId;
    updateRoomMeta();
    renderMembers();
    addChatLine(`系统: 新主持人 ${getDisplayName(msg.hostId)}`);
    return;
  }

  if (msg.type === 'signal') {
    await handleSignal(msg.fromId, msg.signal);
    return;
  }

  if (msg.type === 'chat') {
    addChatLine(`${msg.name}: ${msg.text}`);
    return;
  }

  if (msg.type === 'reaction') {
    addChatLine(`${msg.name} ${msg.reaction}`);
    return;
  }

  if (msg.type === 'force_mute') {
    if (state.localStream) {
      state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
      safeSend({ type: 'media_state', micOn: false });
      addChatLine('系统: 你被主持人静音');
    }
    return;
  }

  if (msg.type === 'force_camera_off') {
    if (state.localStream) {
      state.localStream.getVideoTracks().forEach((t) => (t.enabled = false));
      safeSend({ type: 'media_state', cameraOn: false });
      addChatLine('系统: 你的摄像头被主持人关闭');
    }
    return;
  }

  if (msg.type === 'force_mute_all' && msg.value && state.localStream) {
    state.localStream.getAudioTracks().forEach((t) => (t.enabled = false));
    safeSend({ type: 'media_state', micOn: false });
    addChatLine('系统: 已执行全员静音');
    return;
  }

  if (msg.type === 'kicked') {
    addChatLine('系统: 你已被移出房间');
    state.roomId = null;
    state.members = [];
    state.hostId = null;
    for (const pc of state.peers.values()) pc.close();
    state.peers.clear();
    state.remoteStreams.clear();
    renderVideos();
    renderMembers();
    updateRoomMeta();
  }
};

els.joinBtn.onclick = joinRoom;

els.micBtn.onclick = () => {
  if (!state.localStream) return;
  const audio = state.localStream.getAudioTracks()[0];
  if (!audio) return;
  audio.enabled = !audio.enabled;
  safeSend({ type: 'media_state', micOn: audio.enabled });
};

els.camBtn.onclick = () => {
  if (!state.localStream) return;
  const video = state.localStream.getVideoTracks()[0];
  if (!video) return;
  video.enabled = !video.enabled;
  safeSend({ type: 'media_state', cameraOn: video.enabled });
};

els.shareBtn.onclick = async () => {
  try {
    if (!state.screenStream) {
      state.screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
      const screenTrack = state.screenStream.getVideoTracks()[0];

      for (const pc of state.peers.values()) {
        const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
        if (sender) await sender.replaceTrack(screenTrack);
      }

      screenTrack.onended = async () => {
        const camTrack = state.localStream && state.localStream.getVideoTracks()[0];
        for (const pc of state.peers.values()) {
          const sender = pc.getSenders().find((s) => s.track && s.track.kind === 'video');
          if (sender && camTrack) await sender.replaceTrack(camTrack);
        }
        stopTracks(state.screenStream);
        state.screenStream = null;
      };

      addChatLine('系统: 已开始屏幕共享');
    } else {
      stopTracks(state.screenStream);
      state.screenStream = null;
      addChatLine('系统: 已停止屏幕共享');
    }
  } catch {
    addChatLine('系统: 屏幕共享失败');
  }
};

els.recordBtn.onclick = () => {
  if (!state.localStream) {
    addChatLine('系统: 请先加入房间');
    return;
  }

  if (!state.isRecording) {
    state.recordedChunks = [];
    state.mediaRecorder = new MediaRecorder(state.localStream, { mimeType: 'video/webm;codecs=vp8,opus' });
    state.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) state.recordedChunks.push(e.data);
    };
    state.mediaRecorder.onstop = downloadRecording;
    state.mediaRecorder.start(1000);
    state.isRecording = true;
    els.recordBtn.textContent = '停止录制';
    addChatLine('系统: 本地录制已开始');
  } else {
    state.mediaRecorder.stop();
    state.isRecording = false;
    els.recordBtn.textContent = '开始录制';
    addChatLine('系统: 本地录制已停止，正在下载');
  }
};

els.raiseBtn.onclick = () => {
  state.handRaised = !state.handRaised;
  safeSend({ type: 'raise_hand', value: state.handRaised });
};

els.reactionLike.onclick = () => safeSend({ type: 'reaction', reaction: '👍' });
els.reactionLaugh.onclick = () => safeSend({ type: 'reaction', reaction: '😂' });
els.reactionFire.onclick = () => safeSend({ type: 'reaction', reaction: '🔥' });

els.sendChatBtn.onclick = () => {
  const text = els.chatInput.value.trim();
  if (!text) return;
  safeSend({ type: 'chat', text });
  els.chatInput.value = '';
};

els.lockBtn.onclick = () => safeSend({ type: 'room_lock', locked: !state.locked });
els.muteAllBtn.onclick = () => safeSend({ type: 'mute_all', value: !state.mutedAll });
els.layoutMode.onchange = () => {
  state.layout = els.layoutMode.value;
  renderVideos();
};

window.addEventListener('beforeunload', () => {
  stopTracks(state.localStream);
  stopTracks(state.screenStream);
});

monitorNetwork();

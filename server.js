const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer } = require('ws');
const { v4: uuidv4 } = require('uuid');

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0';
const PUBLIC_DIR = path.join(__dirname, 'public');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8'
};

const rooms = new Map();
const users = new Map();

function ensureRoom(roomId, type = 'public') {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, {
      roomId,
      type,
      hostId: null,
      locked: false,
      members: new Set(),
      createdAt: Date.now(),
      mutedAll: false,
      banned: new Set()
    });
  }
  return rooms.get(roomId);
}

function memberPayload(user, room) {
  return {
    userId: user.userId,
    name: user.name,
    status: 'online',
    micOn: user.micOn,
    cameraOn: user.cameraOn,
    isHost: room.hostId === user.userId,
    handRaised: user.handRaised
  };
}

function roomMembersPayload(room) {
  return [...room.members]
    .map((id) => {
      const user = users.get(id);
      return user ? memberPayload(user, room) : null;
    })
    .filter(Boolean);
}

function send(ws, payload) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(payload));
}

function broadcastRoom(room, payload, exceptUserId = null) {
  for (const uid of room.members) {
    if (uid === exceptUserId) continue;
    const user = users.get(uid);
    if (user) send(user.ws, payload);
  }
}

function emitRoomState(room) {
  broadcastRoom(room, {
    type: 'room_state',
    roomId: room.roomId,
    hostId: room.hostId,
    locked: room.locked,
    mutedAll: room.mutedAll,
    members: roomMembersPayload(room)
  });
}

function cleanupUser(userId) {
  const user = users.get(userId);
  if (!user) return;

  if (user.roomId && rooms.has(user.roomId)) {
    const room = rooms.get(user.roomId);
    room.members.delete(user.userId);

    if (room.hostId === user.userId) {
      room.hostId = room.members.values().next().value || null;
      if (room.hostId) {
        const newHost = users.get(room.hostId);
        if (newHost) send(newHost.ws, { type: 'host_assigned', hostId: room.hostId });
      }
    }

    broadcastRoom(room, { type: 'member_left', userId: user.userId });
    emitRoomState(room);
    if (room.members.size === 0) rooms.delete(room.roomId);
  }

  users.delete(userId);
}

const server = http.createServer((req, res) => {
  let reqPath = req.url === '/' ? '/index.html' : req.url;
  reqPath = reqPath.split('?')[0];

  const safePath = path.normalize(reqPath).replace(/^\.\.(\/|\\|$)/, '');
  const filePath = path.join(PUBLIC_DIR, safePath);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404);
      res.end('Not Found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const userId = uuidv4();
  users.set(userId, {
    userId,
    ws,
    name: `Guest-${userId.slice(0, 6)}`,
    roomId: null,
    micOn: true,
    cameraOn: true,
    handRaised: false
  });

  send(ws, { type: 'connected', userId });

  ws.on('message', (raw) => {
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    const user = users.get(userId);
    if (!user) return;

    if (msg.type === 'create_or_join_room') {
      const roomId = String(msg.roomId || '').trim().slice(0, 64);
      const name = String(msg.name || '').trim().slice(0, 32);
      const roomType = ['public', 'private', 'invite'].includes(msg.roomType) ? msg.roomType : 'public';

      if (!roomId) return send(ws, { type: 'error', message: 'roomId is required' });

      const room = ensureRoom(roomId, roomType);
      if (room.banned.has(userId)) return send(ws, { type: 'error', message: 'You are banned.' });
      if (room.locked && room.members.size > 0 && !room.members.has(userId)) return send(ws, { type: 'error', message: 'Room is locked.' });
      if (room.members.size >= 6 && !room.members.has(userId)) return send(ws, { type: 'error', message: 'Room is full (max 6).' });

      user.name = name || user.name;
      user.roomId = roomId;
      room.members.add(userId);
      if (!room.hostId) room.hostId = userId;

      send(ws, {
        type: 'joined_room',
        roomId,
        hostId: room.hostId,
        locked: room.locked,
        mutedAll: room.mutedAll,
        members: roomMembersPayload(room)
      });

      broadcastRoom(room, { type: 'member_joined', member: memberPayload(user, room) }, userId);
      emitRoomState(room);
      return;
    }

    const room = user.roomId ? rooms.get(user.roomId) : null;
    if (!room) return;

    if (msg.type === 'signal') {
      const target = users.get(msg.targetId);
      if (target && target.roomId === room.roomId) {
        send(target.ws, { type: 'signal', fromId: userId, signal: msg.signal });
      }
      return;
    }

    if (msg.type === 'chat') {
      const text = String(msg.text || '').trim().slice(0, 300);
      if (!text) return;
      broadcastRoom(room, { type: 'chat', fromId: userId, name: user.name, text, ts: Date.now() });
      return;
    }

    if (msg.type === 'reaction') {
      const reaction = String(msg.reaction || '').slice(0, 4);
      if (!reaction) return;
      broadcastRoom(room, { type: 'reaction', fromId: userId, name: user.name, reaction, ts: Date.now() });
      return;
    }

    if (msg.type === 'raise_hand') {
      user.handRaised = !!msg.value;
      emitRoomState(room);
      return;
    }

    if (msg.type === 'media_state') {
      if (typeof msg.micOn === 'boolean') user.micOn = msg.micOn;
      if (typeof msg.cameraOn === 'boolean') user.cameraOn = msg.cameraOn;
      emitRoomState(room);
      return;
    }

    const isHost = room.hostId === userId;
    if (!isHost) return;

    if (msg.type === 'host_set') {
      const targetId = msg.targetId;
      if (!room.members.has(targetId)) return;
      room.hostId = targetId;
      broadcastRoom(room, { type: 'host_assigned', hostId: targetId });
      emitRoomState(room);
      return;
    }

    if (msg.type === 'room_lock') {
      room.locked = !!msg.locked;
      emitRoomState(room);
      return;
    }

    if (msg.type === 'mute_all') {
      room.mutedAll = !!msg.value;
      broadcastRoom(room, { type: 'force_mute_all', value: room.mutedAll });
      emitRoomState(room);
      return;
    }

    if (msg.type === 'member_control') {
      const target = users.get(msg.targetId);
      if (!target || target.roomId !== room.roomId) return;

      if (msg.action === 'kick') {
        send(target.ws, { type: 'kicked', roomId: room.roomId });
        cleanupUser(target.userId);
        return;
      }

      if (msg.action === 'ban') {
        room.banned.add(target.userId);
        send(target.ws, { type: 'kicked', roomId: room.roomId });
        cleanupUser(target.userId);
        return;
      }

      if (msg.action === 'mute') send(target.ws, { type: 'force_mute' });
      if (msg.action === 'camera_off') send(target.ws, { type: 'force_camera_off' });
    }
  });

  ws.on('close', () => cleanupUser(userId));
  ws.on('error', () => cleanupUser(userId));
});

server.listen(PORT, HOST, () => {
  console.log(`RTC Hub server running at http://${HOST}:${PORT}`);
});

# Web RTS - RTC Hub (MVP)

根据 `readme.md` 产品文档实现的可执行 MVP。

## 已实现能力

- 房间创建/加入（公开/私密/受邀类型字段）
- 2-6 人实时音视频通话（WebRTC Mesh）
- WebSocket 信令（SDP/ICE 交换）
- 成员列表 + Host 标识
- Host 控制：设主持人、锁房、全员静音、单人静音、关摄像头、移除、拉黑
- 实时互动：聊天、举手、reaction（👍😂🔥）
- 屏幕共享（浏览器 API）
- 本地录制与下载（MediaRecorder，webm）
- 视频布局切换（Grid / Speaker / Spotlight）
- 基础弱网降级（RTT 估计后动态调整分辨率与帧率）

## 技术栈

- Node.js + ws (signaling)
- Vanilla HTML/CSS/JS + WebRTC

## 快速启动

```bash
npm install
npm start
```

打开浏览器访问：

```text
http://127.0.0.1:3000
```

## 目录

```text
WebRts/
  server.js
  package.json
  public/
    index.html
    styles.css
    app.js
  readme.md         # 产品文档（原始）
  README.md         # 项目说明（本文件）
```

## 当前限制（MVP 取舍）

- 未接入 SFU（当前是 Mesh 拓扑），6 人以内可用
- 未接入 Redis/PostgreSQL，房间状态在内存中
- 未实现云端录制，仅本地录制
- 安全能力（token、TURN 认证、黑名单持久化）为基础版本

后续如需升级到文档里的 SFU 架构，可在 signaling 保持不变的情况下引入 mediasoup/LiveKit。
# WebRts

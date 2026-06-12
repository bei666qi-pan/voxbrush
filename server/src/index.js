/**
 * VoxBrush 声笔 · 服务端
 *  - 静态托管前端构建产物
 *  - /ws/asr   流式语音识别（sherpa-onnx 本地推理）
 *  - /api/agent  L1/L2 指令理解（火山方舟 · 豆包）
 *  - /api/health 全链路自检
 */
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { WebSocketServer } from 'ws';
import { initAsr, asrStatus, attachAsrSocket } from './asr.js';
import { understand } from './agent.js';
import { arkStatus } from './volc.js';

const PORT = Number(process.env.PORT || 8080);
const app = express();
app.use(express.json({ limit: '8mb' }));

const distDir = path.resolve(process.cwd(), 'public');

app.post('/api/agent', async (req, res) => {
  const { text, scene, snapshot } = req.body ?? {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 必填' });
  try {
    const result = await understand({ text: text.slice(0, 500), scene, snapshot });
    res.json(result);
  } catch (e) {
    console.error('[agent]', e.message);
    res.status(502).json({ error: e.message, degraded: true });
  }
});

app.get('/api/health', async (_req, res) => {
  const ark = await arkStatus().catch(e => ({ auth: 'failed', authError: e.message }));
  res.json({
    name: 'voxbrush',
    version: process.env.APP_VERSION || '1.0.0',
    time: new Date().toISOString(),
    asr: asrStatus(),
    ark,
  });
});

// 简单存活探针（Coolify healthcheck 用，不触发外部调用）
app.get('/healthz', (_req, res) => res.json({ ok: true }));

if (fs.existsSync(distDir)) {
  app.use(express.static(distDir, { maxAge: '1d', index: 'index.html' }));
  app.get(/^\/(?!api|ws).*/, (_req, res) => res.sendFile(path.join(distDir, 'index.html')));
}

const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws/asr' });
wss.on('connection', ws => attachAsrSocket(ws));

initAsr();
server.listen(PORT, () => console.log(`[voxbrush] http://0.0.0.0:${PORT}`));

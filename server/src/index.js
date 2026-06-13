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
import { understand, understandStream } from './agent.js';
import { arkStatus, generateImage, renderStyle, initImageModel } from './volc.js';
import { ensureDns, dnsStatus } from './dns.js';

const PORT = Number(process.env.PORT || 8080);
const app = express();
app.use(express.json({ limit: '8mb' }));

const distDir = path.resolve(process.cwd(), 'public');

app.post('/api/agent', async (req, res) => {
  const { text, scene, snapshot, history } = req.body ?? {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 必填' });
  try {
    const result = await understand({ text: text.slice(0, 500), scene, snapshot, history });
    res.json(result);
  } catch (e) {
    console.error('[agent]', e.message);
    res.status(502).json({ error: e.message, degraded: true });
  }
});

/** v1.1：SSE 流式拆解 —— 边生成边下发 op，前端逐笔绘制 */
app.post('/api/agent/stream', async (req, res) => {
  const { text, scene, snapshot, history } = req.body ?? {};
  if (!text || typeof text !== 'string') return res.status(400).json({ error: 'text 必填' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  const send = ev => res.write(`data: ${JSON.stringify(ev)}\n\n`);
  try {
    await understandStream({ text: text.slice(0, 500), scene, snapshot, history }, send);
  } catch (e) {
    console.error('[agent/stream]', e.message);
    send({ type: 'error', message: e.message });
  }
  res.end();
});

/** Seedream 文生图（可选增强，失败不影响核心链路） */
app.post('/api/image', async (req, res) => {
  const { prompt, size } = req.body ?? {};
  if (!prompt || typeof prompt !== 'string') return res.status(400).json({ error: 'prompt 必填' });
  try {
    const result = await generateImage({ prompt: prompt.slice(0, 500), size: size ?? '1024x576' });
    res.json(result);
  } catch (e) {
    console.error('[image]', e.message);
    res.status(502).json({ error: e.message, degraded: true });
  }
});

/** 风格化渲染层（img2img 把矢量画布渲染为某种画风皮肤；失败优雅降级，不影响矢量层） */
app.post('/api/render', async (req, res) => {
  const { image, style, sceneDesc } = req.body ?? {};
  if (!style || typeof style !== 'string') return res.status(400).json({ error: 'style 必填' });
  try {
    const result = await renderStyle({
      image: typeof image === 'string' ? image : undefined,
      style: style.slice(0, 40),
      sceneDesc: String(sceneDesc ?? '').slice(0, 500),
    });
    res.json(result);
  } catch (e) {
    console.error('[render]', e.message);
    res.status(502).json({ error: e.message, degraded: true });
  }
});

app.get('/api/health', async (_req, res) => {
  const ark = await arkStatus().catch(e => ({ auth: 'failed', authError: e.message }));
  res.json({
    name: 'voxbrush',
    version: process.env.APP_VERSION || '1.2.0',
    time: new Date().toISOString(),
    asr: asrStatus(),
    ark,
    dns: dnsStatus(),
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
initImageModel().catch(e => console.warn('[image init]', e.message));
ensureDns().catch(e => console.error('[dns]', e.message));
server.listen(PORT, () => console.log(`[voxbrush] http://0.0.0.0:${PORT}`));

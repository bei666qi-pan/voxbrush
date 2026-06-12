/**
 * 自托管流式 ASR：sherpa-onnx 流式 Zipformer（中英双语，int8）
 * 每个 WebSocket 连接一个解码流；带端点检测（说完自动产出 final）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODEL_DIR = process.env.ASR_MODEL_DIR || path.resolve(process.cwd(), 'models/asr');

function pick(dir, patterns) {
  const files = fs.readdirSync(dir);
  for (const p of patterns) {
    const hit = files.find(f => p.test(f));
    if (hit) return path.join(dir, hit);
  }
  return null;
}

let recognizer = null;
let loadError = null;

export function initAsr() {
  try {
    const sherpa = require('sherpa-onnx-node');
    const encoder = pick(MODEL_DIR, [/encoder.*int8\.onnx$/, /encoder.*\.onnx$/]);
    const decoder = pick(MODEL_DIR, [/decoder.*(?<!int8)\.onnx$/, /decoder.*\.onnx$/]);
    const joiner = pick(MODEL_DIR, [/joiner.*int8\.onnx$/, /joiner.*\.onnx$/]);
    const tokens = pick(MODEL_DIR, [/tokens\.txt$/]);
    if (!encoder || !decoder || !joiner || !tokens) {
      throw new Error(`ASR 模型文件缺失于 ${MODEL_DIR}（需要 encoder/decoder/joiner/tokens）`);
    }
    recognizer = new sherpa.OnlineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder, decoder, joiner },
        tokens,
        numThreads: Number(process.env.ASR_THREADS || 2),
        provider: 'cpu',
        debug: 0,
      },
      decodingMethod: 'greedy_search',
      enableEndpoint: true,
      // 端点规则：静音 2.4s（未开口）/ 0.8s（说完）/ 最长 25s
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: Number(process.env.ASR_TRAILING_SILENCE || 0.8),
      rule3MinUtteranceLength: 25,
    });
    console.log('[asr] sherpa-onnx 流式识别器已加载:', path.basename(encoder));
  } catch (e) {
    loadError = e.message;
    console.error('[asr] 加载失败:', e.message);
  }
  return { ok: !!recognizer, error: loadError };
}

export function asrStatus() {
  return { loaded: !!recognizer, error: loadError, modelDir: MODEL_DIR };
}

/** 将一个 WS 连接接入流式识别 */
export function attachAsrSocket(ws) {
  if (!recognizer) {
    ws.send(JSON.stringify({ type: 'error', message: `ASR 未就绪: ${loadError ?? '初始化中'}` }));
    return;
  }
  const stream = recognizer.createStream();
  let lastPartial = '';
  let segmentStart = Date.now();

  ws.on('message', (data, isBinary) => {
    try {
      if (!isBinary) {
        const msg = JSON.parse(data.toString());
        if (msg.type === 'reset') { recognizer.reset(stream); lastPartial = ''; }
        return;
      }
      // 二进制：Int16 PCM @16kHz 单声道
      const int16 = new Int16Array(data.buffer, data.byteOffset, data.byteLength >> 1);
      const samples = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) samples[i] = int16[i] / 32768;
      stream.acceptWaveform({ samples, sampleRate: 16000 });

      while (recognizer.isReady(stream)) recognizer.decode(stream);
      const text = (recognizer.getResult(stream).text || '').trim();

      if (recognizer.isEndpoint(stream)) {
        if (text) {
          ws.send(JSON.stringify({ type: 'final', text, ms: Date.now() - segmentStart }));
        }
        recognizer.reset(stream);
        lastPartial = '';
        segmentStart = Date.now();
      } else if (text && text !== lastPartial) {
        lastPartial = text;
        ws.send(JSON.stringify({ type: 'partial', text }));
      }
    } catch (e) {
      try { ws.send(JSON.stringify({ type: 'error', message: e.message })); } catch { /* closed */ }
    }
  });
}

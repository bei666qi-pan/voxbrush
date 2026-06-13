/**
 * 自托管流式 ASR：sherpa-onnx 流式 Zipformer（中英双语，int8）
 * 每个 WebSocket 连接一个解码流；带端点检测（说完自动产出 final）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

const MODEL_DIR = process.env.ASR_MODEL_DIR || path.resolve(process.cwd(), 'models/asr');

// 绘图领域热词：提高生僻指令/素材/风格词的识别率（与前端同音纠错双层兜底，零网络延迟）
const HOTWORDS = [
  '生图', '渲染', '水彩', '油画', '吉卜力', '素描', '像素', '扁平', '写实', '卡通', '动漫', '水墨', '赛博朋克', '风格', '滤镜',
  '撤销', '重做', '清空', '保存', '背景', '旋转', '放大', '缩小', '删除', '选中', '美化', '评价',
  '房子', '小屋', '松树', '太阳', '月亮', '彩虹', '雪人', '气球', '小鸟', '小鱼', '小船', '汽车',
  '圆形', '三角形', '五角星', '星星', '爱心', '矩形', '椭圆', '箭头', '直线',
  '红色', '橙色', '黄色', '绿色', '蓝色', '紫色', '粉色', '黑色', '白色',
];

/** 生成 sherpa-onnx 热词文件：中文按建模单元（字）拆分，每行一个词 */
function buildHotwordsFile() {
  const lines = HOTWORDS
    .filter(w => /^[一-龥]+$/.test(w))
    .map(w => w.split('').join(' '));
  const file = path.join(os.tmpdir(), 'voxbrush-hotwords.txt');
  fs.writeFileSync(file, lines.join('\n') + '\n', 'utf8');
  return file;
}

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
let decodingMethod = null;
let hotwordsActive = false;

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
    // 公共配置 + 端点规则：静音 2.4s（未开口）/ 0.8s（说完）/ 最长 25s
    const base = {
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig: {
        transducer: { encoder, decoder, joiner },
        tokens,
        numThreads: Number(process.env.ASR_THREADS || 2),
        provider: 'cpu',
        debug: 0,
      },
      enableEndpoint: true,
      rule1MinTrailingSilence: 2.4,
      rule2MinTrailingSilence: Number(process.env.ASR_TRAILING_SILENCE || 0.8),
      rule3MinUtteranceLength: 25,
    };

    // 热词需要 modified_beam_search。先试热词配置，失败则回退 greedy（保持线上既有行为，绝不拖垮 ASR）。
    const wantHotwords = process.env.ASR_DECODING !== 'greedy';
    let hotwordsFile = null;
    if (wantHotwords) { try { hotwordsFile = buildHotwordsFile(); } catch (e) { console.warn('[asr] 热词文件生成失败:', e.message); } }

    if (hotwordsFile) {
      try {
        recognizer = new sherpa.OnlineRecognizer({
          ...base,
          decodingMethod: 'modified_beam_search',
          maxActivePaths: Number(process.env.ASR_MAX_ACTIVE_PATHS || 4),
          hotwordsFile,
          hotwordsScore: Number(process.env.ASR_HOTWORDS_SCORE || 2.0),
        });
        decodingMethod = 'modified_beam_search';
        hotwordsActive = true;
      } catch (e) {
        console.warn('[asr] 热词/modified_beam_search 不可用，回退 greedy_search:', e.message);
        recognizer = null;
      }
    }
    if (!recognizer) {
      recognizer = new sherpa.OnlineRecognizer({ ...base, decodingMethod: 'greedy_search' });
      decodingMethod = 'greedy_search';
      hotwordsActive = false;
    }
    console.log(`[asr] sherpa-onnx 已加载: ${path.basename(encoder)} | ${decodingMethod}${hotwordsActive ? ` +热词×${HOTWORDS.length}` : ''}`);
  } catch (e) {
    loadError = e.message;
    console.error('[asr] 加载失败:', e.message);
  }
  return { ok: !!recognizer, error: loadError };
}

export function asrStatus() {
  return { loaded: !!recognizer, error: loadError, modelDir: MODEL_DIR, decodingMethod, hotwords: hotwordsActive, hotwordsCount: hotwordsActive ? HOTWORDS.length : 0 };
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

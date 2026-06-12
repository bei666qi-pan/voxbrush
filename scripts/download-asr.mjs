/** 构建期下载流式 ASR 模型（hf-mirror 优先，huggingface 兜底），零 apt 依赖 */
import fs from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const repo = process.env.ASR_REPO || 'csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20';
const files = [
  'encoder-epoch-99-avg-1.int8.onnx',
  'decoder-epoch-99-avg-1.onnx',
  'joiner-epoch-99-avg-1.int8.onnx',
  'tokens.txt',
];
const bases = [
  `https://hf-mirror.com/${repo}/resolve/main`,
  `https://huggingface.co/${repo}/resolve/main`,
];

let lastErr = null;
for (const base of bases) {
  try {
    for (const f of files) {
      process.stdout.write(`下载 ${base}/${f} ... `);
      const res = await fetch(`${base}/${f}`, { redirect: 'follow' });
      if (!res.ok || !res.body) throw new Error(`${f}: HTTP ${res.status}`);
      await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(f));
      const size = fs.statSync(f).size;
      console.log(`${(size / 1e6).toFixed(1)} MB`);
      if (size < 1000) throw new Error(`${f} 文件异常 (${size}B)`);
    }
    console.log('ASR 模型下载完成');
    process.exit(0);
  } catch (e) {
    lastErr = e;
    console.error(`\n源失败 ${base}: ${e.message}，尝试下一个`);
  }
}
throw lastErr;

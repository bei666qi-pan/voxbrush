/**
 * L1/L2 指令理解：把自然语言（+可选画布快照）拆解为绘图 DSL Ops。
 * 输出经 schema 校验，幻觉操作一律丢弃。
 */
import { chat, chatStream, imageModelAvailable } from './volc.js';

const SHAPES = ['circle', 'ellipse', 'rect', 'triangle', 'line', 'arrow', 'star', 'heart', 'polygon', 'text', 'path', 'sprite', 'image'];
const SPRITE_ASSETS = ['house', 'tree', 'pine', 'mountain', 'cloud', 'sun', 'moon', 'flower', 'grass', 'person', 'bird', 'fish', 'boat', 'car', 'rainbow', 'snowman', 'balloon'];
const BASE_OPS = ['add', 'modify', 'delete', 'select', 'undo', 'redo', 'clear', 'background', 'save', 'say', 'help'];

function buildSystem() {
  const imgLine = imageModelAvailable()
    ? '- {"op":"generate_image","prompt":"英文或中文描述","as":"background|object","x":480,"y":300,"w":960,"h":600}（AI 背景/插图，较慢，仅复杂场景可选）'
    : '- 文生图不可用，请用 background+sprite+path 组合实现场景，勿输出 generate_image';
  return `你是 VoxBrush 声笔（一款纯语音控制绘图工具）的指令编译器。
把用户的中文语音指令编译为 JSON 操作数组。画布尺寸 960x600，坐标原点在左上角。

输出格式（只输出 JSON，不要任何解释）：
{"ops":[...], "reply":"一句简短口语化的中文确认（将被朗读，不超过20字）"}

可用操作：
- {"op":"add","shape":"circle|ellipse|rect|triangle|line|arrow|star|heart|polygon|text|path|sprite|image","props":{...}}
  props: x,y(中心) r,w,h x2,y2 points rotation fill stroke strokeWidth opacity text fontSize name
         z(层级,小在下) gradient:{type:"linear|radial",stops:[[0,"#色"],[1,"#色"]],angle:180} shadow:{blur,color,dx,dy}
         d(path 的 SVG path, 以 x,y 为原点 -100~100 坐标) asset(sprite 素材名) palette(颜色数组) src(image URL)
- {"op":"modify","target":T,"set":{属性},"delta":{"dx":0,"dy":0,"scale":1,"rotate":0}}
- {"op":"delete","target":T} | {"op":"select","target":T}
- {"op":"undo"} {"op":"redo"} {"op":"clear"} {"op":"background","color":"#xxx"} {"op":"save"}
- {"op":"say","text":"..."}
${imgLine}
T(目标): {"kind":"last|selected|name|query","name":"太阳","shape":"sprite","color":"red","position":"left|right|top|bottom|center"}

语义素材库 sprite（优先使用，props.asset 取值）：
${SPRITE_ASSETS.join(', ')}

构图规则（扁平插画风格）：
1. 背景层 z=-10：天空用 background 或 linear gradient rect（#87CEEB→#E0F6FF）；
2. 远景 z=0~5：mountain、cloud；
3. 中景 z=10~20：tree、house、boat、person；
4. 近景 z=30+：grass、flower、car；
5. 天空元素 z=50+：sun/moon/rainbow/bird，y<150；
6. 地面线约 y=480，主体落在 200~450；
7. 优先组合 sprite；素材库没有的用 path(d 贝塞尔曲线)；避免纯色矩形堆叠；
8. 给每个对象 props.name（中文名），便于语音指代；
9. 数量词/位置词严格遵守；配色和谐（3~5 主色）。`;
}

function clamp(v, lo, hi) { return typeof v === 'number' ? Math.min(hi, Math.max(lo, v)) : v; }

function sanitizeGradient(g) {
  if (!g || typeof g !== 'object') return undefined;
  const type = g.type === 'radial' ? 'radial' : 'linear';
  const stops = Array.isArray(g.stops) ? g.stops.slice(0, 8).filter(s => Array.isArray(s) && s.length >= 2)
    .map(([o, c]) => [clamp(Number(o), 0, 1), String(c).slice(0, 32)]) : [];
  if (!stops.length) return undefined;
  return { type, stops, angle: g.angle != null ? clamp(g.angle, 0, 360) : undefined };
}

function sanitizeShadow(s) {
  if (!s || typeof s !== 'object') return undefined;
  return { blur: clamp(s.blur ?? 4, 0, 40), color: String(s.color ?? '#00000044').slice(0, 32), dx: clamp(s.dx ?? 0, -50, 50), dy: clamp(s.dy ?? 0, -50, 50) };
}

function sanitizeSrc(src) {
  if (typeof src !== 'string') return undefined;
  const s = src.slice(0, 8000);
  if (/^https:\/\/.+/i.test(s) || /^data:image\//i.test(s)) return s;
  return undefined;
}

export function validateOps(raw) {
  if (!Array.isArray(raw)) return [];
  const ops = imageModelAvailable() ? [...BASE_OPS, 'generate_image'] : BASE_OPS;
  const out = [];
  for (const o of raw.slice(0, 80)) {
    if (!o || typeof o !== 'object' || !ops.includes(o.op)) continue;
    if (o.op === 'add') {
      if (!SHAPES.includes(o.shape)) continue;
      const p = typeof o.props === 'object' && o.props ? { ...o.props } : {};
      p.x = clamp(p.x ?? 480, -200, 1160); p.y = clamp(p.y ?? 300, -200, 800);
      if (p.r != null) p.r = clamp(p.r, 1, 600);
      if (p.w != null) p.w = clamp(p.w, 1, 1200);
      if (p.h != null) p.h = clamp(p.h, 1, 800);
      if (p.fontSize != null) p.fontSize = clamp(p.fontSize, 8, 200);
      if (p.z != null) p.z = clamp(p.z, -200, 200);
      if (p.d != null) p.d = String(p.d).slice(0, 4000);
      if (p.asset != null) {
        p.asset = String(p.asset).slice(0, 32);
        if (!SPRITE_ASSETS.includes(p.asset)) continue;
      }
      if (p.src != null) {
        const src = sanitizeSrc(p.src);
        if (!src) continue;
        p.src = src;
      }
      if (p.gradient) p.gradient = sanitizeGradient(p.gradient);
      if (p.shadow) p.shadow = sanitizeShadow(p.shadow);
      if (p.palette && Array.isArray(p.palette)) p.palette = p.palette.slice(0, 8).map(c => String(c).slice(0, 32));
      o.props = p;
    }
    if (o.op === 'generate_image') {
      if (!imageModelAvailable()) continue;
      o.prompt = String(o.prompt ?? '').slice(0, 500);
      if (!o.prompt) continue;
      o.as = o.as === 'object' ? 'object' : 'background';
      if (o.x != null) o.x = clamp(o.x, 0, 960);
      if (o.y != null) o.y = clamp(o.y, 0, 600);
      if (o.w != null) o.w = clamp(o.w, 50, 960);
      if (o.h != null) o.h = clamp(o.h, 50, 600);
    }
    if (o.op === 'modify') {
      if (typeof o.set === 'object' && o.set) {
        if (o.set.gradient) o.set.gradient = sanitizeGradient(o.set.gradient);
        if (o.set.shadow) o.set.shadow = sanitizeShadow(o.set.shadow);
        if (o.set.d) o.set.d = String(o.set.d).slice(0, 4000);
        if (o.set.src) {
          const src = sanitizeSrc(o.set.src);
          if (src) o.set.src = src; else delete o.set.src;
        }
      }
      if (typeof o.set !== 'object' && typeof o.delta !== 'object') continue;
    }
    if ((o.op === 'modify' || o.op === 'delete' || o.op === 'select') && typeof o.target !== 'object') {
      o.target = { kind: 'last' };
    }
    out.push(o);
  }
  return out;
}

function extractJson(text) {
  if (!text) return null;
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1] : text;
  const start = body.indexOf('{');
  if (start < 0) return null;
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)); } catch { /* shrink */ }
  }
  return null;
}

function buildMessages({ text, scene, snapshot }) {
  const sceneBrief = scene.slice(-40).map(s =>
    `${s.id}:${s.name || s.asset || s.shape}(${s.shape},${s.fill || ''},z${s.z ?? 0},${Math.round(s.x)},${Math.round(s.y)})`
  ).join('; ') || '（空画布）';
  const userContent = snapshot
    ? [
        { type: 'image_url', image_url: { url: snapshot, detail: 'low' } },
        { type: 'text', text: `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}` },
      ]
    : `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}`;
  return [
    { role: 'system', content: buildSystem() },
    { role: 'user', content: userContent },
  ];
}

export async function understandStream({ text, scene = [], snapshot }, onEvent) {
  const t0 = Date.now();
  let emitted = 0;
  const seen = [];
  const tryExtract = (full) => {
    const start = full.search(/"ops"\s*:\s*\[/);
    if (start < 0) return;
    let i = full.indexOf('[', start) + 1;
    let depth = 0, objStart = -1, inStr = false, esc = false;
    for (; i < full.length; i++) {
      const c = full[i];
      if (esc) { esc = false; continue; }
      if (c === '\\') { esc = true; continue; }
      if (c === '"') inStr = !inStr;
      if (inStr) continue;
      if (c === '{') { if (depth === 0) objStart = i; depth++; }
      else if (c === '}') {
        depth--;
        if (depth === 0 && objStart >= 0) {
          const raw = full.slice(objStart, i + 1);
          objStart = -1;
          if (!seen.includes(raw)) {
            seen.push(raw);
            try {
              const [op] = validateOps([JSON.parse(raw)]);
              if (op && seen.length > emitted) {
                emitted = seen.length;
                onEvent({ type: 'op', op, t: Date.now() - t0 });
              }
            } catch { /* ignore */ }
          }
        }
      } else if (c === ']' && depth === 0) break;
    }
  };

  const { content, model } = await chatStream({
    kind: snapshot ? 'vision' : 'text',
    messages: buildMessages({ text, scene, snapshot }),
    onDelta: (_d, full) => { try { tryExtract(full); } catch { /* noop */ } },
  });
  const parsed = extractJson(content) ?? {};
  const ops = validateOps(parsed.ops);
  onEvent({
    type: 'done',
    ops,
    emitted,
    reply: typeof parsed.reply === 'string' ? parsed.reply.slice(0, 60) : (ops.length ? '画好了' : '我没太听懂，换个说法试试'),
    model,
    llmMs: Date.now() - t0,
  });
}

export async function understand({ text, scene = [], snapshot }) {
  const t0 = Date.now();
  const resp = await chat({
    kind: snapshot ? 'vision' : 'text',
    messages: buildMessages({ text, scene, snapshot }),
    temperature: 0.3,
    maxTokens: 4096,
    responseFormat: { type: 'json_object' },
  });
  const content = resp?.choices?.[0]?.message?.content ?? '';
  const parsed = extractJson(content) ?? {};
  const ops = validateOps(parsed.ops);
  return {
    ops,
    reply: typeof parsed.reply === 'string' ? parsed.reply.slice(0, 60) : (ops.length ? '好的' : '我没太听懂，换个说法试试'),
    model: resp?.model,
    usage: resp?.usage,
    llmMs: Date.now() - t0,
  };
}

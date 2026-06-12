/**
 * L1/L2 指令理解：把自然语言（+可选画布快照）拆解为绘图 DSL Ops。
 * 输出经 schema 校验，幻觉操作一律丢弃。
 */
import { chat } from './volc.js';

const SHAPES = ['circle', 'ellipse', 'rect', 'triangle', 'line', 'arrow', 'star', 'heart', 'polygon', 'text'];
const OPS = ['add', 'modify', 'delete', 'select', 'undo', 'redo', 'clear', 'background', 'save', 'say', 'help'];

const SYSTEM = `你是 VoxBrush 声笔（一款纯语音控制绘图工具）的指令编译器。
把用户的中文语音指令编译为 JSON 操作数组。画布尺寸 960x600，坐标原点在左上角。

输出格式（只输出 JSON，不要任何解释）：
{"ops":[...], "reply":"一句简短口语化的中文确认（将被朗读，不超过20字）"}

可用操作：
- {"op":"add","shape":"circle|ellipse|rect|triangle|line|arrow|star|heart|polygon|text","props":{...}}
  props: x,y(中心坐标) r(圆) w,h(宽高) x2,y2(线/箭头终点) points(多边形顶点数组) rotation(度)
         fill(填充色,CSS颜色) stroke strokeWidth opacity text(文字内容) fontSize name(给对象起的中文名)
- {"op":"modify","target":T,"set":{属性},"delta":{"dx":0,"dy":0,"scale":1,"rotate":0}}
- {"op":"delete","target":T} | {"op":"select","target":T}
- {"op":"undo"} {"op":"redo"} {"op":"clear"} {"op":"background","color":"#xxx"} {"op":"save"}
- {"op":"say","text":"..."}（仅当需要向用户解释/提问时单独使用）
T(目标选择器): {"kind":"last"} 最近对象 | {"kind":"selected"} 当前选中 | {"kind":"name","name":"太阳"} |
  {"kind":"query","shape":"circle","color":"red","position":"left|right|top|bottom|center"}

创作要求：
1. 把复杂场景拆解为多个原语操作，合理构图、配色和谐、可重叠遮挡（后画的在上层）；
2. 给关键对象 props.name 起名（如"太阳"、"房子的屋顶"），便于用户后续语音指代；
3. 数量词要遵守（"三朵云"=3 个 add）；位置词要遵守（左/右/上/下/角落/中间）；
4. 用户指令含糊时大胆做合理默认，不要追问；完全无法理解才用 say 提问；
5. 永远不要输出未定义的 op 或 shape。`;

function clamp(v, lo, hi) { return typeof v === 'number' ? Math.min(hi, Math.max(lo, v)) : v; }

export function validateOps(raw) {
  if (!Array.isArray(raw)) return [];
  const out = [];
  for (const o of raw.slice(0, 80)) {
    if (!o || typeof o !== 'object' || !OPS.includes(o.op)) continue;
    if (o.op === 'add') {
      if (!SHAPES.includes(o.shape)) continue;
      const p = typeof o.props === 'object' && o.props ? o.props : {};
      p.x = clamp(p.x ?? 480, -200, 1160); p.y = clamp(p.y ?? 300, -200, 800);
      if (p.r != null) p.r = clamp(p.r, 1, 600);
      if (p.w != null) p.w = clamp(p.w, 1, 1200);
      if (p.h != null) p.h = clamp(p.h, 1, 800);
      if (p.fontSize != null) p.fontSize = clamp(p.fontSize, 8, 200);
      o.props = p;
    }
    if (o.op === 'modify' && typeof o.set !== 'object' && typeof o.delta !== 'object') continue;
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
  // 容错截取最外层 JSON
  for (let end = body.length; end > start; end--) {
    try { return JSON.parse(body.slice(start, end)); } catch { /* shrink */ }
  }
  return null;
}

/**
 * @param {object} p
 * @param {string} p.text 语音转写文本
 * @param {object[]} p.scene 当前场景对象摘要（id/name/shape/color/bbox）
 * @param {string=} p.snapshot 画布 PNG dataURL（触发 L2 视觉理解）
 */
export async function understand({ text, scene = [], snapshot }) {
  const sceneBrief = scene.slice(-40).map(s =>
    `${s.id}:${s.name || s.shape}(${s.shape},${s.fill || ''},中心${Math.round(s.x)},${Math.round(s.y)})`
  ).join('; ') || '（空画布）';

  const userContent = snapshot
    ? [
        { type: 'image_url', image_url: { url: snapshot, detail: 'low' } },
        { type: 'text', text: `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}` },
      ]
    : `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}`;

  const t0 = Date.now();
  const resp = await chat({
    kind: snapshot ? 'vision' : 'text',
    messages: [
      { role: 'system', content: SYSTEM },
      { role: 'user', content: userContent },
    ],
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

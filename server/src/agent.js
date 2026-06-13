/**
 * L1/L2 指令理解：把自然语言（+可选画布快照）拆解为绘图 DSL Ops。
 * 输出经 schema 校验，幻觉操作一律丢弃。
 */
import { chat, chatStream, imageModelAvailable } from './volc.js';

const SHAPES = ['circle', 'ellipse', 'rect', 'triangle', 'line', 'arrow', 'star', 'heart', 'polygon', 'text', 'path', 'sprite', 'image'];
const SPRITE_ASSETS = ['house', 'tree', 'pine', 'mountain', 'cloud', 'sun', 'moon', 'flower', 'grass', 'person', 'bird', 'fish', 'boat', 'car', 'rainbow', 'snowman', 'balloon'];
const BASE_OPS = ['add', 'modify', 'delete', 'select', 'undo', 'redo', 'clear', 'background', 'save', 'say', 'help', 'render_style', 'regen'];

function buildSystem(history) {
  const imgLine = imageModelAvailable()
    ? `- {"op":"generate_image","prompt":"英文或中文描述","as":"background|object","x":480,"y":300,"w":960,"h":600}（文生图：用于素材库没有、且难用矢量表达的复杂内容，如真实感的猫、一片星空背景；较慢）
- {"op":"render_style","style":"水彩|油画|吉卜力|素描|像素|赛博朋克|<自由风格描述>","strength":0.6}（图生图：把用户已画好的整幅画渲染成某种画风/质感，矢量对象仍保留可编辑）
- {"op":"regen","target":T,"prompt":"AI 生成描述"}（物体级重绘：把某个已存在对象替换成 AI 生成图，在其原位原尺寸落图。用于"把那棵树变成真实的樱花树"这类对单个对象的写实化/替换）`
    : '- 文生图/风格渲染当前不可用，请只用 background+sprite+path 组合实现场景，勿输出 generate_image / render_style / regen';

  // 构建历史区块
  let histBlock = '';
  if (history && history.length) {
    const lines = history.slice(-6).map((h, i) => {
      const add = h.lastAdd;
      let desc = `"${h.utterance.slice(0, 40)}"`;
      if (add) desc += ` → 最后画了:${add.asset || add.shape}(颜色${add.fill || '默认'},坐标${add.x ?? '?'},${add.y ?? '?'})`;
      return `  ${i + 1}. ${desc}`;
    });
    histBlock = `
## 对话历史（最近 ${lines.length} 轮）
${lines.join('\n')}

**历史消解规则（非常重要）：**
- "再来一个/再画一个/一样的" → 克隆最近一轮 add 的对象（形状/素材/大小/颜色一样），位置偏移 130px 避免重叠；
- "刚才那种蓝色/颜色" → 从历史中提取最近使用的颜色 fill 值；
- "把它变大/变小/移到..." → "它"指代最近一轮涉及的对象；
- "刚才那棵树/那个房子" → 从历史中匹配同名/同素材对象；
`;
  }

  return `你是 VoxBrush 声笔（一款纯语音控制绘图工具）的指令编译器。
把用户的中文语音指令编译为 JSON 操作数组。画布尺寸 960x600，坐标原点在左上角。
${histBlock}
输出格式（只输出 JSON，不要任何解释）：
{"ops":[...], "reply":"一句简短口语化的中文确认（将作为字幕提示，不超过20字）"}

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
9. 数量词/位置词严格遵守；配色和谐（3~5 主色）。

能力分工（按场景主动选择，不要一律堆矢量）：
- 「画具体的东西」（房子/树/形状/文字）→ 优先 sprite / path / 基础图形，保证可编辑与低延迟；
- 「画素材库没有、且难用矢量表达的复杂写实内容」（一只真实的猫、一片银河星空背景）→ 用 generate_image 文生图；
- 「把已经画好的整幅画变成某种风格/质感/更有艺术感」→ 用 render_style 图生图（不改构图，只换皮肤）。

示例：
- 用户「画一只逼真的橘猫趴在窗台上」→ {"ops":[{"op":"generate_image","prompt":"一只逼真的橘猫趴在窗台上，柔和光线","as":"object","x":480,"y":320,"w":420,"h":320}],"reply":"给你生成一只橘猫"}
- 用户「来个梦幻的星空背景」→ {"ops":[{"op":"generate_image","prompt":"梦幻银河星空，紫蓝色调，繁星点点","as":"background"}],"reply":"星空背景来了"}
- 用户（画布已有村庄）「把整幅画弄成吉卜力风格」→ {"ops":[{"op":"render_style","style":"吉卜力"}],"reply":"正在渲染吉卜力风格"}
- 用户（画布已有一棵树）「把那棵树变成真实的樱花树」→ {"ops":[{"op":"regen","target":{"kind":"name","name":"树"},"prompt":"一棵开满粉色花的真实樱花树，透明背景"}],"reply":"正在重绘樱花树"}`;
}

/** 评画/美化模式的系统提示词 */
function buildReviewSystem(history) {
  const histNote = history?.length
    ? `\n最近操作: ${history.slice(-3).map(h => h.utterance.slice(0, 30)).join('; ')}`
    : '';
  return `你是 VoxBrush 声笔的 AI 绘画评论家。用户正在用语音创作一幅画，请你根据画布快照和场景描述，给出专业但口语化的点评或执行美化操作。

画布尺寸 960x600。${histNote}

**评画模式**（用户说"评价一下我的画"／"这幅画怎么样"等）：
- 返回 {"ops":[{"op":"say","text":"口语化点评 ≤60 字"}], "reply":""}
- 点评要点：构图（平衡/重心/留白）、配色（和谐度/对比/主题感）、可改进之处；
- 语气像画室老师在旁边看画，亲切但不敷衍；
- 如果画布是空的，说"你还没开始画呢，先画点什么吧"。

**美化模式**（用户说"帮我美化构图"／"优化一下画面"等）：
- 返回 {"ops":[...modify/add ops...], "reply":"已美化构图，不满意可以说撤销"}
- 目标：对齐元素位置、让配色更和谐、补背景层次、去除明显不协调的元素；
- 具体可做：调整 z 层级使前景/背景分明、调整 x/y 使元素间距匀称、优化颜色搭配（同类色/互补色）、给天空补 gradient 背景 rect；
- 每个修改用一个 modify op（target 用 name 或 shape 定位），新增元素用 add op；
- 保持用户原意，不做颠覆性改动；
- 如果画布元素 <3 个，说"元素还比较少，多画一些我再帮你调整构图吧"（返回 say 指令）。`;
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
      // 过滤无效 CSS 颜色值 "none"（浏览器 Canvas 会忽略该赋值，保留上次黑色，导致意外描边）
      if (p.stroke === 'none') delete p.stroke;
      if (p.fill === 'none') delete p.fill;
      o.props = p;
    }
    if (o.op === 'render_style') {
      o.style = String(o.style ?? '').slice(0, 40);
      if (!o.style) continue;
      if (o.strength != null) o.strength = clamp(Number(o.strength), 0, 1);
    }
    if (o.op === 'regen') {
      if (!imageModelAvailable()) continue;   // 生图不可用时丢弃
      o.prompt = String(o.prompt ?? '').slice(0, 300);
      if (!o.prompt) continue;
      if (typeof o.target !== 'object') o.target = { kind: 'last' };
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
        // 过滤无效颜色值
        if (o.set.stroke === 'none') delete o.set.stroke;
        if (o.set.fill === 'none') delete o.set.fill;
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

function buildMessages({ text, scene, snapshot, history, reviewMode }) {
  const sceneBrief = scene.slice(-40).map(s =>
    `${s.id}:${s.name || s.asset || s.shape}(${s.shape},${s.fill || ''},z${s.z ?? 0},${Math.round(s.x)},${Math.round(s.y)})`
  ).join('; ') || '（空画布）';

  const system = reviewMode
    ? buildReviewSystem(history)
    : buildSystem(history);

  const userContent = snapshot
    ? [
        { type: 'image_url', image_url: { url: snapshot, detail: 'low' } },
        { type: 'text', text: `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}` },
      ]
    : `画布当前对象: ${sceneBrief}\n用户语音指令: ${text}`;
  return [
    { role: 'system', content: system },
    { role: 'user', content: userContent },
  ];
}

export async function understandStream({ text, scene = [], snapshot, history }, onEvent) {
  const t0 = Date.now();
  let emitted = 0;
  const seen = [];

  // 检测是否为评画/美化指令
  const reviewMode = /评价|点评|打分|看看|审查|怎么样|如何|好不好|美化|优化|改进|提升|调整|润色|改善/.test(text) && snapshot;

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
    messages: buildMessages({ text, scene, snapshot, history, reviewMode }),
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

export async function understand({ text, scene = [], snapshot, history }) {
  const t0 = Date.now();
  const resp = await chat({
    kind: snapshot ? 'vision' : 'text',
    messages: buildMessages({ text, scene, snapshot, history }),
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

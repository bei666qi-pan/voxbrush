import { CANVAS_H, CANVAS_W, Gradient, Node, Op, SceneState, Target } from './types';
import { drawSprite, resolvePalette, SPRITES } from './assets';

let seq = 0;
const nid = () => `n${++seq}_${Date.now().toString(36)}`;

const imageCache = new Map<string, HTMLImageElement>();
const imagePending = new Map<string, Promise<HTMLImageElement>>();

export function loadImage(src: string): Promise<HTMLImageElement> {
  const cached = imageCache.get(src);
  if (cached?.complete && cached.naturalWidth) return Promise.resolve(cached);
  const pending = imagePending.get(src);
  if (pending) return pending;
  const p = new Promise<HTMLImageElement>((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous';
    img.onload = () => { imageCache.set(src, img); imagePending.delete(src); resolve(img); };
    img.onerror = () => { imagePending.delete(src); reject(new Error('image load failed')); };
    img.src = src;
  });
  imagePending.set(src, p);
  return p;
}

export function initialScene(): SceneState {
  return { nodes: [], background: '#ffffff', selectedId: null, lastId: null };
}

// ---------- 颜色工具（用于"红色的圆"目标匹配） ----------
const NAMED: Record<string, [number, number, number]> = {
  red: [231, 76, 60], orange: [230, 126, 34], yellow: [241, 196, 15], green: [46, 204, 113],
  cyan: [26, 188, 156], blue: [52, 152, 219], purple: [155, 89, 182], pink: [253, 121, 168],
  black: [45, 52, 54], white: [255, 255, 255], gray: [149, 165, 166], brown: [141, 110, 99],
};
function hexToRgb(c?: string): [number, number, number] | null {
  if (!c) return null;
  const m = c.replace('#', '').slice(0, 6);
  if (!/^[0-9a-f]{6}$/i.test(m)) return null;
  return [parseInt(m.slice(0, 2), 16), parseInt(m.slice(2, 4), 16), parseInt(m.slice(4, 6), 16)];
}
function colorMatches(fill: string | undefined, want: string): boolean {
  const rgb = hexToRgb(fill);
  const target = NAMED[want] ?? hexToRgb(want);
  if (!rgb || !target) return false;
  const d = Math.hypot(rgb[0] - target[0], rgb[1] - target[1], rgb[2] - target[2]);
  return d < 110;
}

// ---------- 目标选择 ----------
export function resolveTarget(s: SceneState, t?: Target): Node | null {
  const tt = t ?? { kind: 'last' as const };
  const ns = s.nodes;
  if (!ns.length) return null;
  if (tt.kind === 'selected' && s.selectedId) return ns.find(n => n.id === s.selectedId) ?? null;
  if (tt.kind === 'last' || tt.kind === 'selected') {
    return (s.selectedId && ns.find(n => n.id === s.selectedId)) || ns.find(n => n.id === s.lastId) || ns[ns.length - 1];
  }
  if (tt.kind === 'name') {
    const q = (tt.name ?? '').trim();
    return [...ns].reverse().find(n =>
      n.name && (n.name === q || n.name.includes(q) || q.includes(n.name)) ||
      (n.shape === 'sprite' && n.asset && (n.asset === q || SPRITES[n.asset]?.label === q || q.includes(SPRITES[n.asset]?.label ?? ''))),
    ) ?? null;
  }
  let cand = ns.filter(n =>
    (!tt.shape || n.shape === tt.shape) &&
    (!tt.color || colorMatches(n.fill ?? n.stroke ?? n.palette?.[0], tt.color)),
  );
  if (tt.position && cand.length > 1) {
    const score = (n: Node) => ({
      left: -n.x, right: n.x, top: -n.y, bottom: n.y,
      center: -Math.hypot(n.x - CANVAS_W / 2, n.y - CANVAS_H / 2),
    }[tt.position!]);
    cand = [...cand].sort((a, b) => score(b) - score(a)).slice(0, 1);
  }
  return cand[cand.length - 1] ?? null;
}

function autoPlace(s: SceneState): { x: number; y: number } {
  const cells = [[480, 300], [300, 220], [660, 220], [300, 400], [660, 400], [480, 160], [480, 440], [180, 300], [780, 300]];
  for (const [x, y] of cells) {
    if (!s.nodes.some(n => Math.hypot(n.x - x, n.y - y) < 130)) return { x, y };
  }
  return { x: 160 + Math.random() * 640, y: 140 + Math.random() * 320 };
}

const PALETTE = ['#3498db', '#e74c3c', '#2ecc71', '#f1c40f', '#9b59b6', '#e67e22', '#1abc9c'];
let paletteIdx = 0;

export interface ApplyResult {
  changed: boolean;
  effects: {
    say?: string[];
    save?: boolean;
    help?: boolean;
    generateImage?: { prompt: string; as: 'background' | 'object'; x?: number; y?: number; w?: number; h?: number }[];
  };
}

export function applyOps(s: SceneState, ops: Op[]): ApplyResult {
  const effects: ApplyResult['effects'] = { say: [] };
  let changed = false;
  for (const op of ops) {
    switch (op.op) {
      case 'add': {
        const p = op.props ?? {};
        const pos = p.x == null || p.y == null ? autoPlace(s) : { x: p.x!, y: p.y! };
        const node: Node = {
          id: nid(), shape: op.shape, ...p,
          x: pos.x, y: pos.y,
          fill: p.fill ?? (op.shape === 'line' || op.shape === 'arrow' ? undefined : PALETTE[paletteIdx++ % PALETTE.length]),
          stroke: p.stroke ?? (op.shape === 'line' || op.shape === 'arrow' ? '#2d3436' : undefined),
          strokeWidth: p.strokeWidth ?? (op.shape === 'line' || op.shape === 'arrow' ? 4 : 0),
          bornAt: performance.now(),
        };
        if (node.shape === 'circle' && node.r == null) node.r = 60;
        if ((node.shape === 'rect' || node.shape === 'ellipse' || node.shape === 'triangle' || node.shape === 'star' || node.shape === 'heart' || node.shape === 'polygon') && node.w == null) {
          node.w = node.r ? node.r * 2 : 120; node.h = node.h ?? (node.shape === 'ellipse' ? node.w * 0.66 : node.w);
        }
        if (node.shape === 'sprite' && node.asset) {
          const def = SPRITES[node.asset];
          if (def) {
            node.w = node.w ?? def.defaultW;
            node.h = node.h ?? def.defaultH;
            node.palette = resolvePalette(node.asset, node.fill, node.palette);
            node.name = node.name ?? def.label;
            if (node.z == null) node.z = 0;
          }
        }
        if (node.shape === 'path' && (node.w == null || node.h == null)) {
          node.w = node.w ?? 120; node.h = node.h ?? 120;
        }
        if (node.shape === 'image') {
          node.w = node.w ?? 200; node.h = node.h ?? 150;
          if (node.z == null) node.z = 0;
        }
        if (node.shape === 'text') {
          node.fontSize = node.fontSize ?? 36;
          node.fill = op.props?.fill ?? '#2d3436';
          node.text = node.text ?? '你好';
        }
        if ((node.shape === 'line' || node.shape === 'arrow') && node.x2 == null) {
          node.x2 = node.x + (node.w ?? 160); node.y2 = node.y;
        }
        s.nodes.push(node);
        s.lastId = node.id; s.selectedId = node.id;
        changed = true;
        break;
      }
      case 'modify': {
        const n = resolveTarget(s, op.target);
        if (!n) { effects.say!.push('没找到要修改的对象'); break; }
        if (op.set) {
          const set = sanitize(op.set);
          if (n.shape === 'sprite' && set.fill && n.asset) {
            n.palette = resolvePalette(n.asset, set.fill as string, n.palette);
            delete set.fill;
          }
          Object.assign(n, set);
        }
        if (op.delta) {
          if (op.delta.dx) { n.x += op.delta.dx; if (n.x2 != null) n.x2 += op.delta.dx; }
          if (op.delta.dy) { n.y += op.delta.dy; if (n.y2 != null) n.y2 += op.delta.dy; }
          if (op.delta.scale && op.delta.scale > 0) {
            const k = op.delta.scale;
            if (n.r != null) n.r *= k;
            if (n.w != null) n.w *= k;
            if (n.h != null) n.h *= k;
            if (n.fontSize != null) n.fontSize *= k;
            if (n.x2 != null && n.y2 != null) { n.x2 = n.x + (n.x2 - n.x) * k; n.y2 = n.y + (n.y2 - n.y) * k; }
          }
          if (op.delta.rotate) n.rotation = ((n.rotation ?? 0) + op.delta.rotate) % 360;
        }
        s.lastId = n.id; s.selectedId = n.id;
        changed = true;
        break;
      }
      case 'delete': {
        const n = resolveTarget(s, op.target);
        if (!n) { effects.say!.push('没找到要删除的对象'); break; }
        s.nodes = s.nodes.filter(x => x.id !== n.id);
        if (s.selectedId === n.id) s.selectedId = null;
        if (s.lastId === n.id) s.lastId = s.nodes[s.nodes.length - 1]?.id ?? null;
        changed = true;
        break;
      }
      case 'select': {
        const n = resolveTarget(s, op.target);
        if (!n) { effects.say!.push('没找到这个对象'); break; }
        s.selectedId = n.id; s.lastId = n.id;
        changed = true;
        break;
      }
      case 'clear':
        if (s.nodes.length) changed = true;
        s.nodes = []; s.selectedId = null; s.lastId = null;
        break;
      case 'background':
        s.background = op.color; changed = true;
        break;
      case 'save': effects.save = true; break;
      case 'say': effects.say!.push(op.text); break;
      case 'help': effects.help = true; break;
      case 'generate_image':
        effects.generateImage = effects.generateImage ?? [];
        effects.generateImage.push({
          prompt: op.prompt, as: op.as,
          x: op.x, y: op.y, w: op.w, h: op.h,
        });
        break;
      default: break;
    }
  }
  return { changed, effects };
}

/** Insert an image node after API generation */
export function insertImageNode(s: SceneState, src: string, opts: { as: 'background' | 'object'; x?: number; y?: number; w?: number; h?: number; name?: string }) {
  const w = opts.w ?? (opts.as === 'background' ? CANVAS_W : 200);
  const h = opts.h ?? (opts.as === 'background' ? CANVAS_H : 150);
  const node: Node = {
    id: nid(), shape: 'image', src,
    x: opts.x ?? (opts.as === 'background' ? CANVAS_W / 2 : 480),
    y: opts.y ?? (opts.as === 'background' ? CANVAS_H / 2 : 300),
    w, h,
    z: opts.as === 'background' ? -100 : 0,
    name: opts.name ?? (opts.as === 'background' ? '背景' : '生成图'),
    bornAt: performance.now(),
  };
  if (opts.as === 'background') {
    s.nodes = s.nodes.filter(n => !(n.shape === 'image' && n.z != null && n.z <= -100));
  }
  s.nodes.push(node);
  s.lastId = node.id;
  loadImage(src).catch(() => {});
  return node;
}

function sanitize(set: Partial<Node>): Partial<Node> {
  const out: Partial<Node> = { ...set };
  delete (out as Record<string, unknown>).id;
  if (out.r != null) out.r = Math.min(600, Math.max(2, out.r));
  if (out.fontSize != null) out.fontSize = Math.min(200, Math.max(8, out.fontSize));
  if (out.d != null && out.d.length > 4000) out.d = out.d.slice(0, 4000);
  if (out.src != null && out.src.length > 8000) delete out.src;
  return out;
}

function sortedNodes(nodes: Node[]): Node[] {
  return [...nodes].sort((a, b) => {
    const za = a.z ?? 0, zb = b.z ?? 0;
    if (za !== zb) return za - zb;
    return 0;
  });
}

function applyShadow(ctx: CanvasRenderingContext2D, shadow?: Node['shadow']) {
  if (!shadow) return;
  ctx.shadowBlur = shadow.blur;
  ctx.shadowColor = shadow.color;
  ctx.shadowOffsetX = shadow.dx ?? 0;
  ctx.shadowOffsetY = shadow.dy ?? 0;
}

function clearShadow(ctx: CanvasRenderingContext2D) {
  ctx.shadowBlur = 0;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 0;
}

function buildGradient(ctx: CanvasRenderingContext2D, g: Gradient, w: number, h: number): CanvasGradient {
  if (g.type === 'radial') {
    const grad = ctx.createRadialGradient(0, 0, 0, 0, 0, Math.max(w, h) / 2);
    g.stops.forEach(([o, c]) => grad.addColorStop(Math.min(1, Math.max(0, o)), c));
    return grad;
  }
  const angle = ((g.angle ?? 180) * Math.PI) / 180;
  const len = Math.max(w, h) / 2;
  const x0 = -Math.cos(angle) * len, y0 = -Math.sin(angle) * len;
  const x1 = Math.cos(angle) * len, y1 = Math.sin(angle) * len;
  const grad = ctx.createLinearGradient(x0, y0, x1, y1);
  g.stops.forEach(([o, c]) => grad.addColorStop(Math.min(1, Math.max(0, o)), c));
  return grad;
}

export function render(ctx: CanvasRenderingContext2D, s: SceneState, dpr: number) {
  const now = performance.now();
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = s.background;
  ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

  for (const n of sortedNodes(s.nodes)) {
    ctx.save();
    const k = n.bornAt ? Math.min(1, (now - n.bornAt) / 220) : 1;
    const ease = 1 - (1 - k) * (1 - k);
    ctx.translate(n.x, n.y);
    if (n.rotation) ctx.rotate((n.rotation * Math.PI) / 180);
    ctx.scale(ease, ease);
    ctx.globalAlpha = (n.opacity ?? 1) * (0.4 + 0.6 * ease);
    applyShadow(ctx, n.shadow);
    drawShape(ctx, n);
    clearShadow(ctx);
    ctx.restore();

    if (n.id === s.selectedId) {
      ctx.save();
      const b = bbox(n);
      ctx.strokeStyle = '#2E6BE6';
      ctx.lineWidth = 2;
      ctx.setLineDash([6, 4]);
      ctx.strokeRect(b.x - 8, b.y - 8, b.w + 16, b.h + 16);
      ctx.restore();
    }
  }
  ctx.restore();
}

function drawShape(ctx: CanvasRenderingContext2D, n: Node) {
  const w = n.w ?? 120, h = n.h ?? 120;

  if (n.shape === 'sprite' && n.asset) {
    const palette = resolvePalette(n.asset, n.fill, n.palette);
    drawSprite(ctx, n.asset, w, h, palette);
    return;
  }

  if (n.shape === 'image' && n.src) {
    const img = imageCache.get(n.src);
    if (img?.complete && img.naturalWidth) {
      ctx.drawImage(img, -w / 2, -h / 2, w, h);
    } else {
      loadImage(n.src).catch(() => {});
      ctx.fillStyle = '#dfe6e9';
      ctx.fillRect(-w / 2, -h / 2, w, h);
    }
    return;
  }

  if (n.shape === 'path' && n.d) {
    const scaleX = w / 200, scaleY = h / 200;
    ctx.save();
    ctx.scale(scaleX, scaleY);
    const path = new Path2D(n.d);
    if (n.gradient) ctx.fillStyle = buildGradient(ctx, n.gradient, 200, 200);
    else ctx.fillStyle = n.fill ?? 'transparent';
    ctx.fill(path);
    if (n.stroke && n.strokeWidth) {
      ctx.strokeStyle = n.stroke;
      ctx.lineWidth = (n.strokeWidth ?? 1) / Math.min(scaleX, scaleY);
      ctx.stroke(path);
    }
    ctx.restore();
    return;
  }

  ctx.fillStyle = n.gradient ? buildGradient(ctx, n.gradient, w, h) : (n.fill ?? 'transparent');
  ctx.strokeStyle = n.stroke ?? 'transparent';
  ctx.lineWidth = n.strokeWidth ?? 0;
  ctx.lineCap = 'round';
  const path = new Path2D();
  switch (n.shape) {
    case 'circle': path.arc(0, 0, n.r ?? 60, 0, Math.PI * 2); break;
    case 'ellipse': path.ellipse(0, 0, w / 2, h / 2, 0, 0, Math.PI * 2); break;
    case 'rect': roundRect(path, -w / 2, -h / 2, w, h, Math.min(10, w / 8, h / 8)); break;
    case 'triangle': path.moveTo(0, -h / 2); path.lineTo(w / 2, h / 2); path.lineTo(-w / 2, h / 2); path.closePath(); break;
    case 'star': starPath(path, 5, w / 2, w / 4.6); break;
    case 'heart': heartPath(path, w); break;
    case 'polygon': {
      if (n.points?.length) {
        n.points.forEach(([px, py], i) => (i ? path.lineTo(px - n.x, py - n.y) : path.moveTo(px - n.x, py - n.y)));
        path.closePath();
      } else {
        starPath(path, n.sides ?? 6, w / 2, w / 2, true);
      }
      break;
    }
    case 'line': case 'arrow': {
      const dx = (n.x2 ?? n.x + 160) - n.x, dy = (n.y2 ?? n.y) - n.y;
      path.moveTo(0, 0); path.lineTo(dx, dy);
      ctx.stroke(path);
      if (n.shape === 'arrow') {
        const a = Math.atan2(dy, dx), L = 16;
        const hp = new Path2D();
        hp.moveTo(dx, dy);
        hp.lineTo(dx - L * Math.cos(a - 0.45), dy - L * Math.sin(a - 0.45));
        hp.moveTo(dx, dy);
        hp.lineTo(dx - L * Math.cos(a + 0.45), dy - L * Math.sin(a + 0.45));
        ctx.stroke(hp);
      }
      return;
    }
    case 'text': {
      ctx.font = `${n.fontSize ?? 36}px 'PingFang SC','Microsoft YaHei',sans-serif`;
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      if (n.fill) ctx.fillText(n.text ?? '', 0, 0);
      if (n.stroke && n.strokeWidth) ctx.strokeText(n.text ?? '', 0, 0);
      return;
    }
  }
  if (n.fill || n.gradient) ctx.fill(path);
  if (n.stroke && n.strokeWidth) ctx.stroke(path);
}

function roundRect(p: Path2D, x: number, y: number, w: number, h: number, r: number) {
  p.moveTo(x + r, y); p.arcTo(x + w, y, x + w, y + h, r); p.arcTo(x + w, y + h, x, y + h, r);
  p.arcTo(x, y + h, x, y, r); p.arcTo(x, y, x + w, y, r); p.closePath();
}
function starPath(p: Path2D, n: number, R: number, r: number, regular = false) {
  const steps = regular ? n : n * 2;
  for (let i = 0; i < steps; i++) {
    const rad = regular ? R : (i % 2 === 0 ? R : r);
    const a = (Math.PI * 2 * i) / steps - Math.PI / 2;
    const x = rad * Math.cos(a), y = rad * Math.sin(a);
    i ? p.lineTo(x, y) : p.moveTo(x, y);
  }
  p.closePath();
}
function heartPath(p: Path2D, w: number) {
  const s = w / 32;
  p.moveTo(0, 10 * s);
  p.bezierCurveTo(-20 * s, -8 * s, -8 * s, -18 * s, 0, -8 * s);
  p.bezierCurveTo(8 * s, -18 * s, 20 * s, -8 * s, 0, 10 * s);
  p.closePath();
}

export function bbox(n: Node): { x: number; y: number; w: number; h: number } {
  if (n.shape === 'circle') { const r = n.r ?? 60; return { x: n.x - r, y: n.y - r, w: r * 2, h: r * 2 }; }
  if (n.shape === 'line' || n.shape === 'arrow') {
    const x2 = n.x2 ?? n.x + 160, y2 = n.y2 ?? n.y;
    return { x: Math.min(n.x, x2), y: Math.min(n.y, y2) - 4, w: Math.abs(x2 - n.x) || 8, h: Math.abs(y2 - n.y) || 8 };
  }
  if (n.shape === 'text') {
    const fs = n.fontSize ?? 36, tw = (n.text?.length ?? 2) * fs;
    return { x: n.x - tw / 2, y: n.y - fs / 2, w: tw, h: fs };
  }
  const w = n.w ?? (n.shape === 'sprite' && n.asset ? SPRITES[n.asset]?.defaultW ?? 120 : 120);
  const h = n.h ?? (n.shape === 'sprite' && n.asset ? SPRITES[n.asset]?.defaultH ?? 120 : 120);
  return { x: n.x - w / 2, y: n.y - h / 2, w, h };
}

export function sceneBrief(s: SceneState) {
  return s.nodes.map(n => ({
    id: n.id, name: n.name, shape: n.shape, fill: n.fill,
    asset: n.asset, z: n.z,
    x: Math.round(n.x), y: Math.round(n.y),
    w: n.w && Math.round(n.w), h: n.h && Math.round(n.h), r: n.r && Math.round(n.r),
    text: n.text,
  }));
}

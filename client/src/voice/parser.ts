/**
 * L0 本地语法解析器：<5ms 把高频中文绘图指令编译为 DSL Ops。
 * 解析失败返回 null，由上层升级到 L1(LLM)。
 * 设计原则：宽进严出 —— 词法层大量容错（同音字/口语词/数词），语义层只在有把握时产出。
 */
import { CANVAS_H, CANVAS_W, Op, Shape, Target } from '../engine/types';
import { normalizeNumbers, zhToNum } from './zhNumbers';

// ---------- 词法容错（同音字 / 口语词归一） ----------
const HOMOPHONE: [RegExp, string][] = [
  [/园(形|圈)?/g, '圆形'], [/元形/g, '圆形'], [/[华划話](一?个|条|根|只)/g, '画$1'],
  [/绘制|创建|添加/g, '画'], [/搞(一?个)/g, '画$1'], [/来(一?个)/g, '画$1'], [/整(一?个)/g, '画$1'],
  [/撤回|回退|后退一步|返回上一步|取消刚才/g, '撤销'],
  [/取消撤销/g, '重做'],
  [/橡皮擦?掉|擦掉|移除|去掉|删掉/g, '删除'],
  [/全部清除|清除画布|清空所有|重新开始|重画/g, '清空'],
  [/涂成|填充成?|上色为?|染成/g, '改成'], [/变为/g, '变成'],
  [/挪|平移/g, '移'], [/放到|移动到|拖到/g, '移到'],
  [/标题|题目/g, '文字'],
];

const COLORS: Record<string, string> = {
  红: '#e74c3c', 橙: '#e67e22', 橘: '#e67e22', 黄: '#f1c40f', 金: '#fdcb6e',
  绿: '#2ecc71', 青: '#1abc9c', 蓝: '#3498db', 天蓝: '#74b9ff',
  紫: '#9b59b6', 粉: '#fd79a8', 粉红: '#fd79a8',
  黑: '#2d3436', 白: '#ffffff', 灰: '#95a5a6', 棕: '#8d6e63', 咖啡: '#8d6e63',
  深蓝: '#0a3d62', 深绿: '#1e8449',
};
const COLOR_BASE = '天蓝|粉红|咖啡|红|橙|橘|黄|金|绿|青|蓝|紫|粉|黑|白|灰|棕';
const COLOR_EN: Record<string, string> = {
  红: 'red', 橙: 'orange', 橘: 'orange', 黄: 'yellow', 金: 'yellow', 绿: 'green', 青: 'cyan',
  蓝: 'blue', 天蓝: 'blue', 紫: 'purple', 粉: 'pink', 粉红: 'pink', 黑: 'black', 白: 'white',
  灰: 'gray', 棕: 'brown', 咖啡: 'brown',
};

function colorHex(mod: string | undefined, base: string): string {
  if (mod === '深' && COLORS['深' + base]) return COLORS['深' + base];
  let hex = COLORS[base] ?? '#3498db';
  if (mod === '浅' || mod === '淡') hex = shade(hex, 0.45);
  else if (mod === '深') hex = shade(hex, -0.3);
  return hex;
}
function shade(hex: string, k: number): string {
  const v = hex.replace('#', '');
  const f = (i: number) => {
    const c = parseInt(v.slice(i, i + 2), 16);
    const n = k > 0 ? c + (255 - c) * k : c * (1 + k);
    return Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0');
  };
  return `#${f(0)}${f(2)}${f(4)}`;
}

const SHAPE_WORDS: [string, Shape, Partial<{ sides: number }>][] = [
  ['长方形|矩形|正方形|方块|方形', 'rect', {}],
  ['椭圆形?', 'ellipse', {}],
  ['圆形|圆圈|圈圈|圆|圈', 'circle', {}],
  ['[三3]角形?', 'triangle', {}],
  ['[五5]角星|星星|星形|星', 'star', {}],
  ['爱心|心形|桃心|红心|心', 'heart', {}],
  ['[六6]边形', 'polygon', { sides: 6 }],
  ['[五5]边形', 'polygon', { sides: 5 }],
  ['[八8]边形', 'polygon', { sides: 8 }],
  ['箭头', 'arrow', {}],
  ['横线|竖线|斜线|直线|线条|线段|线', 'line', {}],
];
const SHAPE_ALT = SHAPE_WORDS.map(w => w[0]).join('|');
function shapeOf(word: string): [Shape, Partial<{ sides: number }>] | null {
  for (const [src, shape, extra] of SHAPE_WORDS) {
    if (new RegExp(`^(${src})$`).test(word)) return [shape, extra];
  }
  return null;
}

const POSITIONS: Record<string, { x: number; y: number; pos: Target['position'] }> = {
  左上角: { x: 190, y: 130, pos: 'left' }, 右上角: { x: 770, y: 130, pos: 'right' },
  左下角: { x: 190, y: 470, pos: 'left' }, 右下角: { x: 770, y: 470, pos: 'right' },
  正中间: { x: 480, y: 300, pos: 'center' }, 正中央: { x: 480, y: 300, pos: 'center' },
  中间: { x: 480, y: 300, pos: 'center' }, 中央: { x: 480, y: 300, pos: 'center' }, 中心: { x: 480, y: 300, pos: 'center' },
  左边: { x: 210, y: 300, pos: 'left' }, 左侧: { x: 210, y: 300, pos: 'left' },
  右边: { x: 750, y: 300, pos: 'right' }, 右侧: { x: 750, y: 300, pos: 'right' },
  上面: { x: 480, y: 140, pos: 'top' }, 上方: { x: 480, y: 140, pos: 'top' }, 顶部: { x: 480, y: 110, pos: 'top' },
  下面: { x: 480, y: 460, pos: 'bottom' }, 下方: { x: 480, y: 460, pos: 'bottom' }, 底部: { x: 480, y: 490, pos: 'bottom' },
  天上: { x: 480, y: 120, pos: 'top' }, 地上: { x: 480, y: 500, pos: 'bottom' },
};
const POS_RE = Object.keys(POSITIONS).join('|');

const SIZES: Record<string, number> = {
  巨大: 2.2, 特别大: 1.9, 很大: 1.7, 超大: 1.9, 大大: 1.6, 大: 1.4,
  中等: 1, 小小: 0.6, 很小: 0.5, 特别小: 0.4, 迷你: 0.4, 小: 0.7,
};
const SIZE_RE = '巨大|特别大|很大|超大|大大|中等|小小|很小|特别小|迷你|大|小';

/** 同音/口语归一（不做数词转换，保护文字内容） */
export function normalize(raw: string): string {
  let t = raw.trim()
    .replace(/[！!？?。.~～\s]+$/g, '')
    .replace(/^(请|帮我|给我|麻烦|那个就|嗯+|呃+|然后)+/, '')
    .replace(/[呀啊吧呢哦嘛]+$/, '');
  for (const [re, sub] of HOMOPHONE) t = t.replace(re, sub);
  return t;
}

/** 数词转换 + 量词修复（一点/一些/一下 不应被转成 1点） */
function numfix(seg: string): string {
  return normalizeNumbers(seg)
    .replace(/1(点|些|下)/g, '一$1')
    .replace(/(再|稍微?)1(?=大|小)/g, '$1');
}

// ---------- 目标提取 ----------
const PRONOUN_RE = /^(把|让|将)?(它|他|这个东西|那个东西)/;
const DEMONSTRATIVE_RE = /^(把|让|将)?(这个|那个|刚才那个|刚才的)(?=的|改|变|换|大|小|往|向|移|转|旋|删|放|缩|$)/;

function extractTarget(seg: string): { target: Target; rest: string } {
  if (PRONOUN_RE.test(seg)) {
    return { target: { kind: 'last' }, rest: seg.replace(PRONOUN_RE, '').replace(/^的/, '') };
  }
  if (DEMONSTRATIVE_RE.test(seg)) {
    return { target: { kind: 'last' }, rest: seg.replace(DEMONSTRATIVE_RE, '').replace(/^的/, '') };
  }
  // "把[左边的][红色的][圆]..."
  const q = seg.match(new RegExp(
    `^(?:把|让|将)(?:那个|这个)?(?:(?<pos>${POS_RE})的?)?(?:(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?的?)?(?<shape>${SHAPE_ALT})的?`,
  ));
  if (q?.groups?.shape) {
    const found = shapeOf(q.groups.shape);
    const target: Target = { kind: 'query', shape: found?.[0] };
    if (q.groups.base) target.color = COLOR_EN[q.groups.base] ?? 'blue';
    if (q.groups.pos) target.position = POSITIONS[q.groups.pos]?.pos;
    return { target, rest: seg.slice(q[0].length) };
  }
  // 名字引用："把太阳改成红色"
  const nm = seg.match(/^(?:把|让|将)([^改变换大小往向移转删旋缩放的]{1,8}?)的?(?=改|变|换|大|小|往|向|移|转|旋|删|缩|放)/);
  if (nm) return { target: { kind: 'name', name: nm[1] }, rest: seg.slice(nm[0].length) };

  return { target: { kind: 'last' }, rest: seg.replace(/^(把|让|将)/, '') };
}

// ---------- 单段解析 ----------
function parseSegment(segRaw: string): Op[] | null {
  if (!segRaw) return [];
  const s = numfix(segRaw);

  // 系统指令
  if (/^(帮助|你能做什么|怎么用|使用说明|指令列表|你会什么|能画什么)/.test(s)) return [{ op: 'help' }];
  if (/^撤销(一步|刚才)?$/.test(s)) return [{ op: 'undo' }];
  if (/^(重做|恢复)$/.test(s)) return [{ op: 'redo' }];
  if (/^清空(画布)?/.test(s)) return [{ op: 'clear' }, { op: 'say', text: '画布已清空' }];
  if (/^(保存|下载|导出)(图片|画布|作品)?$/.test(s)) return [{ op: 'save' }, { op: 'say', text: '已保存图片' }];

  // 背景
  const bg = s.match(new RegExp(`^背景(?:颜色)?(?:改成|换成|变成|设为|用)?(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?$`))
    ?? s.match(new RegExp(`^(?:把)?(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?的?背景$`));
  if (bg?.groups?.base) {
    return [{ op: 'background', color: colorHex(bg.groups.mod, bg.groups.base) }, { op: 'say', text: '背景已更换' }];
  }

  // 删除
  if (/^删除|^(把|将).{0,12}删除?$/.test(s)) {
    let cleaned = s.replace(/删除?$/, '改').replace(/^删除/, '把');
    if (!cleaned.startsWith('把')) cleaned = `把${cleaned}`;
    if (cleaned === '把改' || cleaned === '把') return [{ op: 'delete', target: { kind: 'last' } }];
    const { target } = extractTarget(cleaned);
    return [{ op: 'delete', target }];
  }

  // 选择
  const sel = s.match(/^(选中|选择|选)(.+)/);
  if (sel) {
    const { target } = extractTarget(`把${sel[2]}改`);
    return [{ op: 'select', target }];
  }

  // 写文字（用原始段落保护文字内容，字号单独转数字）
  const wt = segRaw.match(/(?:写上?|加上?文字|文字写?|打上)[，,]?\s*["'“‘]?(.+?)["'”’]?(?:[，,]?\s*(?:字号|大小)([零一二两三四五六七八九十百千\d]+))?$/);
  if (wt && wt[1] && !/^(写|文字|上)$/.test(segRaw)) {
    let content = wt[1].replace(/[，,]\s*$/, '');
    const fontSize = wt[2] ? (zhToNum(wt[2]) ?? 40) : 40;
    let fill: string | undefined, x: number | undefined, y: number | undefined;
    const cm = content.match(new RegExp(`^(深|浅|淡)?(${COLOR_BASE})色的`));
    if (cm) { fill = colorHex(cm[1], cm[2]); content = content.slice(cm[0].length); }
    const pm = content.match(new RegExp(`^在?(${POS_RE})`));
    if (pm) { x = POSITIONS[pm[1]].x; y = POSITIONS[pm[1]].y; content = content.replace(pm[0], '').replace(/^写上?/, ''); }
    content = content.trim();
    if (!content) return null;
    return [
      { op: 'add', shape: 'text', props: { text: content, fontSize, fill, x, y, name: content.slice(0, 6) } },
      { op: 'say', text: `已写上「${content.slice(0, 10)}」` },
    ];
  }

  return parseModify(s) ?? parseDraw(s);
}

function parseModify(s: string): Op[] | null {
  const { target, rest } = extractTarget(s);
  const r = rest || s;

  // 改颜色
  const c = r.match(new RegExp(`^(?:颜色)?(?:改成|换成|变成)(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?的?$`));
  if (c?.groups?.base) return [{ op: 'modify', target, set: { fill: colorHex(c.groups.mod, c.groups.base) } }, { op: 'say', text: '颜色改好了' }];
  // 边框
  const bd = r.match(new RegExp(`^(?:边框|描边)(?:改成|换成|变成|用)?(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?(?:，?粗细(?<w>\\d+))?$`));
  if (bd?.groups?.base) {
    return [{ op: 'modify', target, set: { stroke: colorHex(bd.groups.mod, bd.groups.base), strokeWidth: bd.groups.w ? parseInt(bd.groups.w) : 4 } }];
  }

  // 大小
  if (/^(再|稍微?)?(变|放)?大(一点|一些|点儿?|号)?$/.test(r)) return [{ op: 'modify', target, delta: { scale: 1.3 } }];
  if (/^(再|稍微?)?(变|缩)?小(一点|一些|点儿?|号)?$/.test(r)) return [{ op: 'modify', target, delta: { scale: 0.75 } }];
  const sc = r.match(/^(放大|缩小)(?:到|成)?(\d+(?:\.\d+)?)倍$/);
  if (sc) {
    const k = parseFloat(sc[2]);
    return [{ op: 'modify', target, delta: { scale: sc[1] === '放大' ? k : 1 / k } }];
  }
  const rr = r.match(/^半径(?:改成|变成|设为)?(\d+)$/);
  if (rr) return [{ op: 'modify', target, set: { r: parseInt(rr[1]) } }];

  // 移动
  const mv = r.match(/^(?:往|向)?(左上|右上|左下|右下|左|右|上|下)(?:移动?|边)(\d+)?(?:像素|个像素|点)?(一点|一些)?$/);
  if (mv) {
    const d = mv[2] ? parseInt(mv[2]) : (mv[3] ? 40 : 80);
    const dx = mv[1].includes('左') ? -d : mv[1].includes('右') ? d : 0;
    const dy = mv[1].includes('上') ? -d : mv[1].includes('下') ? d : 0;
    return [{ op: 'modify', target, delta: { dx, dy } }];
  }
  const mvTo = r.match(new RegExp(`^移到(${POS_RE})$`));
  if (mvTo) {
    const p = POSITIONS[mvTo[1]];
    return [{ op: 'modify', target, set: { x: p.x, y: p.y } }];
  }
  const mvXY = r.match(/^移到\D*(\d+)\D+(\d+)$/);
  if (mvXY) return [{ op: 'modify', target, set: { x: clampW(parseInt(mvXY[1])), y: clampH(parseInt(mvXY[2])) } }];

  // 旋转
  const rot = r.match(/^(顺时针|逆时针)?旋?转(\d+)?度?(一下)?$/);
  if (rot && (rot[1] || rot[2] || rot[3] || /旋转/.test(r))) {
    const deg = (rot[2] ? parseInt(rot[2]) : 45) * (rot[1] === '逆时针' ? -1 : 1);
    return [{ op: 'modify', target, delta: { rotate: deg } }];
  }
  // 透明度
  const op2 = r.match(/^(?:透明度|不透明度)(?:改成|设为)?(\d+)/);
  if (op2) return [{ op: 'modify', target, set: { opacity: Math.min(100, parseInt(op2[1])) / 100 } }];

  return null;
}

function parseDraw(s: string): Op[] | null {
  let x: number | undefined, y: number | undefined;
  let str = s;

  // 位置（句首/句中/句尾）
  const posM = str.match(new RegExp(`(?:在|去)?(${POS_RE})(?=画|来|加|放)`))
    ?? str.match(new RegExp(`(?:放?在|位于)(${POS_RE})$`));
  if (posM) {
    const p = POSITIONS[posM[1]];
    x = p.x; y = p.y;
    str = str.replace(posM[0], '');
  }
  // 坐标
  const xy = str.match(/坐标\D*(\d+)\D+(\d+)/);
  if (xy) { x = clampW(parseInt(xy[1])); y = clampH(parseInt(xy[2])); }

  // 显式尺寸（先提值，再从匹配串中剥离，避免干扰主模式）
  let r: number | undefined, w: number | undefined, h: number | undefined;
  const rm = str.match(/半径\D{0,3}(\d+)/); if (rm) r = parseInt(rm[1]);
  const dm = str.match(/直径\D{0,3}(\d+)/); if (dm) r = parseInt(dm[1]) / 2;
  const wm = str.match(/宽\D{0,3}(\d+)/); if (wm) w = parseInt(wm[1]);
  const hm = str.match(/高\D{0,3}(\d+)/); if (hm) h = parseInt(hm[1]);
  const sm = str.match(/(?:大小|尺寸|边长)\D{0,3}(\d+)/); if (sm) w = h = parseInt(sm[1]);
  const lm = str.match(/长度?\D{0,3}(\d+)/); if (lm) w = parseInt(lm[1]);
  str = str
    .replace(/(?:半径|直径|大小|尺寸|边长|宽|高|长度?)\D{0,3}\d+(?:像素|个像素)?的?/g, '')
    .replace(/坐标\D*\d+\D+\d+的?/g, '')
    .replace(/在$/, '');

  if (!/画|加|放/.test(str)) str = '画' + str;

  const m = str.match(new RegExp(
    `(?:画|加|放)\\s*(?<count>\\d+)?(?:个|条|根|颗|朵|只|枚|道|座)?` +
    `(?<size1>${SIZE_RE})?的?` +
    `(?:(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?的?)?` +
    `(?<size2>${SIZE_RE})?的?` +
    `(?<shape>${SHAPE_ALT})`,
  ));
  if (!m?.groups?.shape) return null;
  const g = m.groups;

  const count = Math.min(g.count ? parseInt(g.count) : 1, 12);
  const found = shapeOf(g.shape);
  if (!found) return null;
  const [shape, extra] = found;
  const k = (g.size1 ?? g.size2) ? SIZES[(g.size1 ?? g.size2)!] ?? 1 : 1;
  const fill = g.base ? colorHex(g.mod, g.base) : undefined;

  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const props: Partial<Record<string, unknown>> & { w?: number; h?: number } = { fill, ...extra };
    if (x != null) props.x = x + (count > 1 ? (i - (count - 1) / 2) * 150 * k : 0);
    if (y != null) props.y = y;
    if (shape === 'circle') props.r = (r ?? 60) * k;
    else if (shape === 'line' || shape === 'arrow') {
      const len = (w ?? 160) * k;
      if (/竖线/.test(g.shape)) { props.w = 0; props.h = len; }
      else if (/斜线/.test(g.shape)) { props.w = len * 0.7; props.h = len * 0.7; }
      else { props.w = len; props.h = 0; }
      if (fill) { props.stroke = fill; props.fill = undefined; }
    } else {
      const base = w ?? (r ? r * 2 : 120);
      props.w = base * k;
      props.h = (h ?? (shape === 'ellipse' ? base * 0.66 : base)) * k;
    }
    ops.push({ op: 'add', shape, props } as Op);
  }
  const colorName = g.base ? `${g.mod ?? ''}${g.base}色` : '';
  ops.push({ op: 'say', text: `好的，${count > 1 ? count + '个' : ''}${colorName}${g.shape}画好了` });
  return ops;
}

const clampW = (v: number) => Math.min(CANVAS_W - 20, Math.max(20, v));
const clampH = (v: number) => Math.min(CANVAS_H - 20, Math.max(20, v));

// ---------- 多指令切分（"字号40"等参数段回贴前段） ----------
function splitSegments(t: string): string[] {
  const parts = t.split(/[。；;]|然后|接着|之后再|完了/).flatMap(p => p.split(/[，,]/)).map(p => p.trim()).filter(Boolean);
  const merged: string[] = [];
  for (const p of parts) {
    if (merged.length && /^(字号|大小|颜色|半径|粗细|宽|高|长)[零一二两三四五六七八九十百千\d]/.test(p)) {
      merged[merged.length - 1] += `，${p}`;
    } else {
      merged.push(p.replace(/^(然后|接着|之后|再)(?=画|写|加|来|放|把|改|删|选)/, ''));
    }
  }
  return merged;
}

export interface ParseOutcome { ops: Op[]; reply?: string; }

/** 入口：全部段落解析成功才返回；任一段失败返回 null（升级 LLM） */
export function parseLocal(raw: string): ParseOutcome | null {
  const t = normalize(raw);
  if (!t || t.length > 64) return null;
  const segs = splitSegments(t);
  if (!segs.length) return null;
  const all: Op[] = [];
  const says: string[] = [];
  for (const seg of segs) {
    const ops = parseSegment(seg);
    if (ops == null) return null;
    for (const o of ops) {
      if (o.op === 'say') says.push(o.text);
      else all.push(o);
    }
  }
  if (!all.length && !says.length) return null;
  return { ops: all, reply: says[says.length - 1] };
}

/** 是否包含视觉指代（L0 失败时决定是否带画布快照走 L2） */
export function needsVision(raw: string): boolean {
  return /左边|右边|上面|下面|中间|旁边|附近|之间|重叠|挡住|空白|看看|评价|好看|构图|美化|这幅|整体/.test(raw);
}

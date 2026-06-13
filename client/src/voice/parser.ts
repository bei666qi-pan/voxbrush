/**
 * L0 本地语法解析器：<5ms 把高频中文绘图指令编译为 DSL Ops。
 * 解析失败返回 null，由上层升级到 L1(LLM)。
 * 设计原则：宽进严出 —— 词法层大量容错（同音字/口语词/数词），语义层只在有把握时产出。
 */
import { CANVAS_H, CANVAS_W, HistoryEntry, Op, Shape, Target } from '../engine/types';
import { SPRITES } from '../engine/assets';
import { normalizeNumbers, zhToNum } from './zhNumbers';
import { getLastAdd, macroExists, replayMacro, createMacro, deleteMacro, listMacros } from '../engine/scene';

// ---------- 领域同音纠错（生图/渲染/风格词 —— 自托管 ASR 易误识别，纯本地正则 <1ms，零网络） ----------
// 这是最稳的兜底层：独立于服务端 ASR 热词生效，把高频误识别归一回正确指令词。
const DOMAIN_HOMOPHONE: [RegExp, string][] = [
  [/申屠|生土|声图|圣图|生途|深图/g, '生图'],
  [/水菜|水才|睡彩/g, '水彩'],
  [/渲图|宣染|选染|渲色|玄染/g, '渲染'],
  [/记不力|吉布力|吉卜利|及不力|急不力|几不力/g, '吉卜力'],
  [/由画|油华|游画/g, '油画'],
  [/速描|素瞄|苏描/g, '素描'],
  [/像速|向素|象素/g, '像素'],
  [/疯格|风个/g, '风格'],
  [/拍照风|拍立得风/g, '写实风'],
];

/** 仅做领域同音纠错（供 HUD 展示「原文 → 纠错后」）。不改变其它语义。 */
export function correctDomain(raw: string): string {
  let t = raw;
  for (const [re, sub] of DOMAIN_HOMOPHONE) t = t.replace(re, sub);
  return t;
}

// ---------- 词法容错（同音字 / 口语词归一） ----------
const HOMOPHONE: [RegExp, string][] = [
  [/园(形|圈)?/g, '圆形'], [/元形/g, '圆形'], [/[华划話](一?个|条|根|只)/g, '画$1'],
  [/绘制|创建|添加/g, '画'], [/搞(一?个)/g, '画$1'], [/来(一?个)/g, '画$1'], [/整(一?个)/g, '画$1'],
  [/撤回|回退|后退一步|返回上一步|取消刚才/g, '撤销'],
  [/取消撤销/g, '重做'],
  [/橡皮擦?掉|擦掉|移除|去掉|删掉/g, '删除'],
  [/全部清除|清除画布|清空所有|重新开始|重画/g, '清空'],
  // 注意：负向后瞻保护「渲染成」不被 染成→改成 误伤
  [/涂成|填充成?|上色为?|(?<!渲)染成/g, '改成'], [/变为/g, '变成'],
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

/** 语义素材库名词 → asset id */
const SPRITE_WORDS: [string, string][] = [
  ['房子|小屋|房屋|房', 'house'],
  ['(?:小|大)?树(?!屋)|(?:小|大)?树木', 'tree'],
  ['松树|圣诞树', 'pine'],
  ['(?:远|大|小)?山|山峰|山脉', 'mountain'],
  ['(?:白)?云(?:朵)?|云彩', 'cloud'],
  ['太阳|日', 'sun'],
  ['月亮|月', 'moon'],
  ['(?:小|大)?花(?:朵)?', 'flower'],
  ['草(?:丛|地)?|小草', 'grass'],
  ['小人|人(?:物)?|小孩|男孩|女孩', 'person'],
  ['鸟(?:儿)?|小鸟', 'bird'],
  ['鱼(?:儿)?|小鱼', 'fish'],
  ['船(?:只)?|小舟|小船', 'boat'],
  ['(?:汽)?车|小车|汽车', 'car'],
  ['彩虹', 'rainbow'],
  ['雪人', 'snowman'],
  ['气球', 'balloon'],
];
const SPRITE_ALT = SPRITE_WORDS.map(w => w[0]).join('|');
const SHAPE_ALT = SHAPE_WORDS.map(w => w[0]).join('|');

function spriteOf(word: string): string | null {
  for (const [src, asset] of SPRITE_WORDS) {
    if (new RegExp(`^(${src})$`).test(word)) return asset;
  }
  return null;
}
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

// ---------- 风格化渲染（img2img 皮肤层） ----------
/** [识别词正则, 规范风格名] */
const STYLE_WORDS: [string, string][] = [
  ['水彩', '水彩'], ['油画|油彩', '油画'], ['吉卜力|宫崎骏', '吉卜力'],
  ['素描|铅笔画|炭笔画?|手绘线稿', '素描'], ['像素|八位|八比特|马赛克', '像素'],
  ['扁平', '扁平'], ['写实|实拍|照片级?|真实感?|超写实', '写实'],
  ['卡通', '卡通'], ['动漫|二次元|日漫|番剧', '动漫'],
  ['水墨|国画|中国画', '水墨'], ['赛博朋克|赛博|未来科技感?', '赛博朋克'],
  ['蜡笔', '蜡笔'], ['梵高', '梵高'], ['莫奈|印象派', '印象派'],
  ['极简|简约', '极简'], ['复古|怀旧|胶片', '复古'],
  ['低多边形|低聚', '低多边形'], ['蒸汽波', '蒸汽波'],
  ['粘土|黏土', '粘土'], ['霓虹|发光', '霓虹'], ['水晶|玻璃质感?', '水晶'],
];
const STYLE_ALT = STYLE_WORDS.map(w => w[0]).join('|');
function styleOf(word: string): string {
  for (const [src, name] of STYLE_WORDS) if (new RegExp(`^(?:${src})$`).test(word)) return name;
  return word;
}

/** L0 风格渲染解析：命中已知风格直接产出 render_style op（<5ms，不走 LLM）。
 *  必须在「删除」处理之前调用——「去掉风格」经同音规则会先变成「删除风格」。 */
function parseRender(s: string): Op[] | null {
  // 去掉风格 / 还原（含 去掉→删除 同音规则归一后的形态）
  if (/^(?:删除|去掉|取消|移除|清除|关闭|还原|恢复)(?:风格|滤镜|渲染|画风|皮肤|效果|风格层|渲染层)$/.test(s)
      || /^(?:还原|恢复)(?:画面|矢量层?|原图|原样)$/.test(s)) {
    return [{ op: 'render_style', style: 'none' }];
  }
  const m =
    s.match(new RegExp(`^(?:把)?(?:我的|这幅|整幅|整张|这张|当前)?画?(?:渲染|风格化|生图|画风|转换|变|改)(?:成|为)?(?<style>${STYLE_ALT})(?:风格?|画风|滤镜|质感|效果)?$`))
    ?? s.match(new RegExp(`^(?:来点|加上?|上|套上?|用)(?<style>${STYLE_ALT})(?:风格?|画风|滤镜|质感|效果)$`))
    ?? s.match(new RegExp(`^(?<style>${STYLE_ALT})(?:风格?化|滤镜|质感)$`))
    ?? s.match(new RegExp(`^(?:整体|整幅|整张)?(?<style>${STYLE_ALT})(?:风|风格)$`));
  if (m?.groups?.style) {
    const style = styleOf(m.groups.style);
    return [{ op: 'render_style', style }, { op: 'say', text: `正在把整幅画渲染成${style}风格，大约十秒` }];
  }
  return null;
}

/** L0 物体级 AI 重绘：「把<对象>变成<描述>」→ 在该对象原位用 AI 生成图替换。
 *  纯颜色/大小修饰交给 parseModify；其余视为 AI 重绘描述。 */
function parseRegen(s: string): Op[] | null {
  const m = s.match(/^(?:把|将|让)(?<obj>.{1,10}?)(?:变成|换成|重绘成|重画成|改绘成|变为)(?<desc>.{2,40})$/);
  if (!m?.groups) return null;
  const desc = m.groups.desc.trim();
  // 纯颜色/大小修饰 → 不是 AI 重绘
  if (new RegExp(`^(?:颜色)?(?:深|浅|淡)?(?:${COLOR_BASE})色?$`).test(desc)) return null;
  if (new RegExp(`^(?:再|更|稍微?)?(?:${SIZE_RE})(?:一点|一些|点儿?)?(?:的)?$`).test(desc)) return null;
  // 目标对象（去指示代词/量词；"它/那个东西" 等 → 最近对象）
  const objRaw = m.groups.obj
    .replace(/^(?:那|这|刚才那?|此)(?:个|棵|只|条|朵|座|辆|艘|束|片|张|杯)?/, '')
    .replace(/(?:东西|玩意儿?)$/, '')
    .trim();
  const target: Target = (!objRaw || /^(?:它|他|她)$/.test(objRaw)) ? { kind: 'last' } : { kind: 'name', name: objRaw };
  return [
    { op: 'regen', target, prompt: desc },
    { op: 'say', text: `好的，正在用 AI 重绘${objRaw || '它'}，大约十秒` },
  ];
}

/** 同音/口语归一（不做数词转换，保护文字内容） */
export function normalize(raw: string): string {
  let t = raw.trim()
    .replace(/[！!？?。.~～\s]+$/g, '')
    .replace(/^(请|帮我|给我|麻烦|那个就|嗯+|呃+|然后)+/, '')
    .replace(/[呀啊吧呢哦嘛]+$/, '');
  for (const [re, sub] of DOMAIN_HOMOPHONE) t = t.replace(re, sub);  // 领域纠错先行（保护「渲染成」等）
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
  // 名字引用："把太阳改成红色" / "把房子改成蓝色"
  const nm = seg.match(/^(?:把|让|将)([^改变换大小往向移转删旋缩放的]{1,8}?)的?(?=改|变|换|大|小|往|向|移|转|旋|删|缩|放)/);
  if (nm) return { target: { kind: 'name', name: nm[1] }, rest: seg.slice(nm[0].length) };

  return { target: { kind: 'last' }, rest: seg.replace(/^(把|让|将)/, '') };
}

// ---------- 单段解析 ----------
function parseSegment(segRaw: string): Op[] | null {
  if (!segRaw) return [];
  const s = numfix(segRaw);

  // 评画/美化 → 升级 L2，L0 不处理
  if (isReviewOrBeautify(s)) return null;

  // 系统指令
  if (/^(帮助|你能做什么|怎么用|使用说明|指令列表|你会什么|能画什么)/.test(s)) return [{ op: 'help' }];
  if (/^撤销(一步|刚才)?$/.test(s)) return [{ op: 'undo' }];
  if (/^(重做|恢复)$/.test(s)) return [{ op: 'redo' }];
  if (/^清空(画布)?/.test(s)) return [{ op: 'clear' }, { op: 'say', text: '画布已清空' }];
  if (/^(保存|下载|导出)(图片|画布|作品)?$/.test(s)) return [{ op: 'save' }, { op: 'say', text: '已保存图片' }];

  // 风格渲染（必须在「删除」之前：「去掉风格」会被同音规则先转成「删除风格」）
  const render = parseRender(s);
  if (render) return render;

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

  return parseClone(s) ?? parseMacro(s) ?? parseRegen(s) ?? parseModify(s) ?? parseDraw(s);
}

// ---------- 克隆（多轮上下文：再来一个/再画一个/一样的颜色） ----------
function parseClone(s: string): Op[] | null {
  // "再来一个/再画一个/再画一棵/一样的"
  const cloneM = s.match(/^(再来|再画|再[加放搞整])(一?[个条根颗朵只枚道座棵辆艘]?)((?:一样的?)?)$/);
  if (cloneM) {
    const last = getLastAdd();
    if (!last) return [{ op: 'say', text: '还没画过东西呢，先画点什么吧' }];
    // 检查是否有"一样的颜色"意图
    const sameColor = /一样/.test(s) && /色|颜/.test(s);
    const props: Record<string, unknown> = {};
    props.shape = last.shape;
    if (last.asset) props.asset = last.asset;
    if (last.name) props.name = last.name;
    if (last.w) props.w = last.w;
    if (last.h) props.h = last.h;
    if (last.r) props.r = last.r;
    if (last.palette) props.palette = last.palette;
    // 偏移 130px 避免重叠
    props.x = (last.x ?? 480) + 130;
    props.y = (last.y ?? 300);
    // 颜色：如果用户说"一样的颜色"，保留原色；否则轮换
    props.fill = sameColor ? last.fill : undefined;
    const ops: Op[] = [{ op: 'add', shape: last.shape, props } as Op];
    ops.push({ op: 'say', text: `好的，再画一个${last.name ?? last.asset ?? ''}` });
    return ops;
  }

  // "换成刚才那种蓝色" / "用刚才的颜色"
  const prevColorM = s.match(/(?:刚才|之前|上次|上个|那种|一样的?)(?:那种|的)?(?:颜色|色|蓝色|红色|绿色|黄色|紫色|粉色|白色|黑色|灰色)/);
  if (prevColorM) {
    const last = getLastAdd();
    if (!last?.fill) return [{ op: 'say', text: '没找到之前的颜色' }];
    // 这是一个 modify 意图：把选中对象改成上次的颜色
    const target = extractTarget(s.replace(/刚才|之前|上次|上个|那种|一样的?/g, '').replace(/的?颜色|的?色/g, ''));
    return [{ op: 'modify', target: target.target, set: { fill: last.fill } }, { op: 'say', text: '颜色改好了' }];
  }

  // "一样的颜色" 作为独立指令（给当前选中的对象）
  if (/^(?:和?刚才|之前|上次|上个|那种|)一样的?(?:颜色|色)$/.test(s)) {
    const last = getLastAdd();
    if (!last?.fill) return [{ op: 'say', text: '没找到之前的颜色' }];
    return [{ op: 'modify', target: { kind: 'last' }, set: { fill: last.fill } }, { op: 'say', text: '颜色改好了' }];
  }

  return null;
}

// ---------- 语音宏 ----------
function parseMacro(s: string): Op[] | null {
  // "记住这个叫XXX" / "记住这N个叫XXX"
  const rememberM = s.match(/^记住(?:这|那)?(?:些|个|组)?(?:叫|为|是)?(.{1,10}?)(?:吧|哦|呀|呢)?$/);
  if (rememberM && rememberM[1].length >= 1 && rememberM[1].length <= 8) {
    const name = rememberM[1].trim();
    // 检查是否与素材/形状冲突
    const spriteNames = ['房子', '小屋', '房屋', '房', '树', '松树', '圣诞树', '山', '山峰', '山脉',
      '云', '云朵', '云彩', '太阳', '月亮', '花', '花朵', '草', '草丛', '小草', '小人', '人',
      '男孩', '女孩', '鸟', '小鸟', '鱼', '小鱼', '船', '小舟', '车', '汽车', '彩虹', '雪人', '气球'];
    const shapeNames = ['圆', '圆形', '椭圆', '矩形', '方形', '正方形', '三角形', '五角星', '星星', '爱心', '心形',
      '六边形', '五边形', '八边形', '箭头', '横线', '竖线', '斜线', '直线', '线条'];
    if (spriteNames.includes(name) || shapeNames.includes(name)) {
      return [{ op: 'say', text: `「${name}」是内置素材名，请换个名字` }];
    }
    // 创建宏：使用场景中所有节点或最近一批同句产生的节点
    // L0 只能拿到 current scene，通过 window 访问
    const win = (typeof window !== 'undefined' ? window as unknown : undefined) as Record<string, unknown> | undefined;
    const scene = win?.['__voxbrush_scene'] as { nodes: Array<{ id: string; x: number; y: number; shape: string; asset?: string; w?: number; h?: number; r?: number; fill?: string; palette?: string[]; name?: string; z?: number }> } | undefined;
    if (!scene?.nodes?.length) return [{ op: 'say', text: '画布上还没有东西可以记住' }];
    const ok = createMacro(name, scene.nodes as Parameters<typeof createMacro>[1]);
    if (ok) return [{ op: 'say', text: `记住了，以后说「画一个${name}」就可以复用` }];
    return [{ op: 'say', text: '记住宏失败了' }];
  }

  // "忘记XXX" / "删除宏XXX"
  const forgetM = s.match(/^(?:忘记|删除宏?|移除宏?)(.{1,10}?)(?:吧|哦|呀|呢)?$/);
  if (forgetM) {
    const name = forgetM[1].trim();
    if (deleteMacro(name)) return [{ op: 'say', text: `已忘记「${name}」` }];
    return [{ op: 'say', text: `没有叫「${name}」的宏` }];
  }

  // "我记住了什么" / "宏列表" / "有哪些宏"
  if (/^(?:我|你)(?:记住|有)(?:了?|过?)?(?:什么|哪些|几个?)(?:宏|东西|对象)?/.test(s) || /^(?:宏|宏列表|列出宏|查看宏)/.test(s)) {
    const macros = listMacros();
    if (!macros.length) return [{ op: 'say', text: '你还没有记住任何东西。试试说「记住这个叫小屋」' }];
    return [{ op: 'say', text: `你记住了：${macros.join('、')}` }];
  }

  // "画一个XXX"（宏回放）
  const drawMacroM = s.match(new RegExp(
    `^(?:画|加|放|来)\\s*(?<count>\\d+)?(?:个|组|份)?\\s*(?<size>${SIZE_RE})?的?\\s*(?<name>.{1,10}?)$`,
  ));
  if (drawMacroM?.groups?.name) {
    const name = drawMacroM.groups.name.trim();
    if (!macroExists(name)) return null; // 不是宏，让后续 draw 流程处理
    const count = Math.min(drawMacroM.groups.count ? parseInt(drawMacroM.groups.count) : 1, 12);
    const k = drawMacroM.groups.size ? SIZES[drawMacroM.groups.size] ?? 1 : 1;
    // 获取位置：从句子中提取
    const posM = s.match(new RegExp(`(?:在|去)?(${POS_RE})`));
    let cx = 480, cy = 300;
    if (posM) {
      const p = POSITIONS[posM[1]];
      cx = p.x; cy = p.y;
    }
    return replayMacro(name, cx, cy, k, count);
  }

  return null;
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
    `(?:画|加|放)\\s*(?<count>\\d+)?(?:个|条|根|颗|朵|只|枚|道|座|棵|辆|艘|条|片)?` +
    `(?<size1>${SIZE_RE})?的?` +
    `(?:(?<mod>深|浅|淡)?(?<base>${COLOR_BASE})色?的?)?` +
    `(?<size2>${SIZE_RE})?的?` +
    `(?<thing>${SPRITE_ALT}|${SHAPE_ALT})`,
  ));
  if (!m?.groups?.thing) return null;
  const g = m.groups;

  const count = Math.min(g.count ? parseInt(g.count) : 1, 12);
  const asset = spriteOf(g.thing);
  const found = asset ? null : shapeOf(g.thing);
  if (!asset && !found) return null;

  const k = (g.size1 ?? g.size2) ? SIZES[(g.size1 ?? g.size2)!] ?? 1 : 1;
  const fill = g.base ? colorHex(g.mod, g.base) : undefined;

  const ops: Op[] = [];
  for (let i = 0; i < count; i++) {
    const props: Partial<Record<string, unknown>> = { fill };
    if (x != null) props.x = x + (count > 1 ? (i - (count - 1) / 2) * 150 * k : 0);
    if (y != null) props.y = y;

    if (asset) {
      const def = SPRITES[asset];
      props.asset = asset;
      props.name = def?.label ?? asset;
      props.w = (def?.defaultW ?? 120) * k;
      props.h = (def?.defaultH ?? 120) * k;
      if (/云|太阳|月亮|彩虹|鸟/.test(g.thing)) props.z = 10;
      if (/山|树|松树|房子|草/.test(g.thing)) props.z = 0;
      ops.push({ op: 'add', shape: 'sprite', props } as Op);
    } else {
      const [shape, extra] = found!;
      Object.assign(props, extra);
      if (shape === 'circle') props.r = (r ?? 60) * k;
      else if (shape === 'line' || shape === 'arrow') {
        const len = (w ?? 160) * k;
        if (/竖线/.test(g.thing)) { props.w = 0; props.h = len; }
        else if (/斜线/.test(g.thing)) { props.w = len * 0.7; props.h = len * 0.7; }
        else { props.w = len; props.h = 0; }
        if (fill) { props.stroke = fill; props.fill = undefined; }
      } else {
        const base = w ?? (r ? r * 2 : 120);
        props.w = base * k;
        props.h = (h ?? (shape === 'ellipse' ? base * 0.66 : base)) * k;
      }
      ops.push({ op: 'add', shape, props } as Op);
    }
  }
  const label = asset ? (SPRITES[asset]?.label ?? g.thing) : g.thing;
  const colorName = g.base ? `${g.mod ?? ''}${g.base}色` : '';
  ops.push({ op: 'say', text: `好的，${count > 1 ? count + '个' : ''}${colorName}${label}画好了` });
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
  return /左边|右边|上面|下面|中间|旁边|附近|之间|重叠|挡住|空白|看看|评价|好看|构图|美化|这幅|整体|打分|意见|建议|改进|提升|优化|改得更好/.test(raw);
}

/** 是否为评画/美化指令（必须走 L2 多模态，L0 不处理） */
export function isReviewOrBeautify(raw: string): boolean {
  const t = normalize(raw);
  return /^(?:评价|点评|打分|看看|审查).*(?:画|作品|构图|怎么样|如何|好不好)/.test(t) ||
    /^(?:帮我?|请|来)?(?:美化|优化|改进|提升|调整|润色|改善).*(?:构图|画|作品|画面|布局|配色)/.test(t) ||
    /^这幅画/.test(t) && /怎么样|如何|评价|好看/.test(t) ||
    /^画的(?:怎么|好不|如)/.test(t);
}

/** L0 解析器冒烟测试：npx tsx client/test/parser.test.ts */
import { parseLocal, normalize, correctDomain, isReviewOrBeautify, needsVision } from '../src/voice/parser';

const cases: [string, boolean, string?][] = [
  // [指令, 期望 L0 命中, 备注]

  // === 基础图形 ===
  ['画一个红色的圆', true],
  ['画一个圆', true],
  ['在左上角画一个大的红色圆形', true],
  ['画三颗星星', true],
  ['画个半径120的蓝色圆', true],
  ['画一条横线', true],
  ['画一个六边形', true],
  ['来一个绿色的爱心', true],
  ['画一个五角星', true],
  ['画一个箭头', true],

  // === 文字 ===
  ['写上七牛云，字号40', true],
  ['写上 你好世界', true],
  ['写上 声笔，字号六十', true],

  // === 修改 ===
  ['大一点', true],
  ['再大一点', true],
  ['缩小一点', true],
  ['放大到2倍', true],
  ['往左移50', true],
  ['向右移一点', true],
  ['移到左下角', true],
  ['改成绿色', true],
  ['把它改成蓝色', true],
  ['把红色的圆改成黄色', true],
  ['旋转45度', true],
  ['逆时针旋转30度', true],

  // === 删除/选择/系统 ===
  ['删除', true],
  ['把那个星星删掉', true],
  ['选中那个蓝色的方块', true],
  ['撤销', true],
  ['重做', true],
  ['清空画布', true],
  ['保存图片', true],
  ['背景换成深蓝色', true],
  ['帮助', true],

  // === 语义素材 ===
  ['画一棵树', true],
  ['在左下角画一座房子', true],
  ['画三棵小树', true],
  ['画一个太阳', true],
  ['画一朵花', true],
  ['画一朵云', true],
  ['画一座山', true],
  ['画一只鸟', true],
  ['画一条鱼', true],
  ['画一个雪人', true],
  ['画一条彩虹', true],

  // === 多指令 ===
  ['画一个圆，然后改成红色，再大一点', true],

  // === 同音容错 ===
  ['华一个园形', true],
  ['搞一个紫色的三角形', true],

  // === 克隆/多轮上下文（L0 低垂果实） ===
  // 注：克隆需要 lastAdd 有值，测试环境无历史时返回 say

  // === 评画/美化 → L2 升级 ===
  ['评价一下我的画', false, 'L2 评画'],
  ['帮我美化构图', false, 'L2 美化'],
  ['看看这幅画怎么样', false, 'L2 评画'],
  ['优化一下画面', false, 'L2 美化'],
  ['这幅画好不好看', false, 'L2 评画'],
  ['帮我改进构图', false, 'L2 美化'],

  // === 复合场景 → L1 升级 ===
  ['画一座房子，旁边有一棵树，天上有太阳和云', false],
  ['把整幅画变得更有秋天的感觉', false],
  ['在圆和方块之间画一条连接线', false],

  // === 风格渲染 render_style（L0 命中） ===
  ['把我的画渲染成水彩风', true],
  ['渲染成吉卜力风格', true],
  ['来点油画风格', true],
  ['水彩风格化', true],
  ['整体赛博朋克风', true],
  ['去掉风格', true],          // 去掉→删除 同音后仍应命中 render_style none
  ['还原画面', true],
  ['申屠成水彩风', true, 'ASR 误识别→纠错→render_style'],

  // === 物体级 AI 重绘 regen（L0 命中） ===
  ['把那棵树变成真实的樱花树', true],
  ['把它变成一只真实的猫', true],
  ['把房子变成蓝色', true],     // 这是 modify(颜色)，不应是 regen
];

let pass = 0, fail = 0;
for (const [text, expectLocal, note] of cases) {
  const r = parseLocal(text);
  const hit = r != null;
  const ok = hit === expectLocal;
  if (ok) pass++;
  else {
    fail++;
    console.log(`✗ "${text}"${note ? ` [${note}]` : ''} 期望${expectLocal ? 'L0 命中' : '升级 LLM'} 实际${hit ? 'L0' : 'LLM'}  norm="${normalize(text)}"`);
    if (r) console.log('   ops:', JSON.stringify(r.ops).slice(0, 200));
  }
}

// ---------- 关键语义抽查 ----------

// 1. 位置+大小+颜色
const r1 = parseLocal('在左上角画一个大的红色圆形')!;
const add1 = r1.ops.find(o => o.op === 'add') as { props: Record<string, number | string> };
console.assert(add1.props.x === 190 && add1.props.y === 130, '位置解析错误', add1.props);
console.assert((add1.props.r as number) > 60, '大小修饰未生效', add1.props);
console.assert((add1.props.fill as string).startsWith('#e7'), '颜色解析错误', add1.props);

// 2. 数量词
const r2 = parseLocal('画三颗星星')!;
console.assert(r2.ops.filter(o => o.op === 'add').length === 3, '数量词未生效');

// 3. 目标查询（颜色+形状）
const r3 = parseLocal('把红色的圆改成黄色')!;
const mod = r3.ops.find(o => o.op === 'modify') as { target: { kind: string; color?: string } };
console.assert(mod.target.kind === 'query' && mod.target.color === 'red', '目标查询解析错误', mod.target);

// 4. 素材库（house）
const r4 = parseLocal('在左下角画一座房子')!;
const house = r4.ops.find(o => o.op === 'add') as { shape: string; props: { asset?: string; x?: number; y?: number } };
console.assert(house.shape === 'sprite' && house.props.asset === 'house', '素材解析错误', house);
console.assert(house.props.x === 190 && house.props.y === 470, '素材位置错误', house.props);

// 5. 素材库（tree）+ 数量词
const r5 = parseLocal('画三棵小树')!;
console.assert(r5.ops.filter(o => o.op === 'add').length === 3, '树数量词未生效');
console.assert((r5.ops[0] as { props: { asset?: string } }).props.asset === 'tree', '树素材错误');

// 6. 同音容错
const r6 = parseLocal('华一个园形')!;
console.assert(r6.ops.some(o => o.op === 'add'), '同音容错失败');

// 7. 造字容错
const r7 = parseLocal('搞一个紫色的三角形')!;
console.assert(r7.ops.some(o => o.op === 'add'), '造字容错失败');

// 8. 删除
const r8 = parseLocal('把那个星星删掉')!;
console.assert(r8.ops.some(o => o.op === 'delete'), '删除解析失败');

// 9. 多指令切分
const r9 = parseLocal('画一个圆，然后改成红色，再大一点')!;
const ops9 = r9.ops.map(o => o.op);
console.assert(ops9.includes('add') && ops9.includes('modify'), '多指令切分失败', ops9);

// 10. 背景颜色
const r10 = parseLocal('背景换成深蓝色')!;
console.assert(r10.ops.some(o => o.op === 'background'), '背景解析失败');

// 11. 文字写入
const r11 = parseLocal('写上 七牛云，字号四十')!;
const txt = r11.ops.find(o => o.op === 'add' && (o as { shape: string }).shape === 'text') as { props: { text: string; fontSize: number } } | undefined;
console.assert(txt?.props.text === '七牛云', '文字内容错误', txt?.props.text);
console.assert(txt?.props.fontSize === 40, '字号解析错误', txt?.props.fontSize);

// 12. 素材库覆盖（17种全部可解析）
const spriteTests = [
  ['画一座房子', 'house'],
  ['画一棵树', 'tree'],
  ['画一棵松树', 'pine'],
  ['画一座山', 'mountain'],
  ['画一朵云', 'cloud'],
  ['画一个太阳', 'sun'],
  ['画一个月亮', 'moon'],
  ['画一朵花', 'flower'],
  ['画一片草丛', 'grass'],
  ['画一个小人', 'person'],
  ['画一只鸟', 'bird'],
  ['画一条鱼', 'fish'],
  ['画一条船', 'boat'],
  ['画一辆车', 'car'],
  ['画一道彩虹', 'rainbow'],
  ['画一个雪人', 'snowman'],
  ['画一个气球', 'balloon'],
];
for (const [cmd, asset] of spriteTests) {
  const r = parseLocal(cmd);
  console.assert(r != null, `素材指令应命中: ${cmd}`);
  const add = r!.ops.find(o => o.op === 'add') as { props: { asset?: string } } | undefined;
  console.assert(add?.props?.asset === asset, `素材 ${cmd} → ${asset}，实际 ${add?.props?.asset}`, add?.props);
}

// 13. 评画/美化检测
console.assert(isReviewOrBeautify('评价一下我的画'), '应检测为评画');
console.assert(isReviewOrBeautify('帮我美化构图'), '应检测为美化');
console.assert(isReviewOrBeautify('这幅画怎么样'), '应检测为评画');
console.assert(isReviewOrBeautify('优化一下画面'), '应检测为美化');
console.assert(!isReviewOrBeautify('画一个圆'), '不应检测为评画');

// 14. needsVision 检测
console.assert(needsVision('把左边那个改成蓝色'), '应触发视觉');
console.assert(needsVision('评价一下构图'), '应触发视觉');

console.assert(!needsVision('画一个圆'), '纯绘制不应触发视觉');

// 15. 同音容错（更多组合）
const homoTests = [
  ['华一个三角形', true],
  ['搞个蓝色的方块', true],
  ['整一个圆', true],
  ['撤回', true],  // → 撤销
  ['后退一步', true],
  ['橡皮擦掉', true],  // → 删除
  ['全部清除', true],  // → 清空
];
for (const [cmd, expected] of homoTests) {
  const r = parseLocal(cmd);
  console.assert((r != null) === expected, `同音容错: ${cmd} → ${normalize(cmd)}`);
}

// 16. 位置词覆盖
const posTests = [
  ['在左上角画', '左上角'],
  ['在右下角画', '右下角'],
  ['在正中间画', '正中间'],
  ['在左边画', '左边'],
  ['在天上画', '天上'],
];
for (const [cmd, pos] of posTests) {
  const r = parseLocal(`${cmd}一个圆`);
  console.assert(r != null, `位置指令应命中: ${cmd}`);
}

// 17. 领域同音纠错（生图/水彩/渲染/吉卜力）
console.assert(correctDomain('申屠成水彩风') === '生图成水彩风', '申屠→生图纠错失败:', correctDomain('申屠成水彩风'));
console.assert(correctDomain('水菜画') === '水彩画', '水菜→水彩纠错失败:', correctDomain('水菜画'));
console.assert(correctDomain('记不力风格') === '吉卜力风格', '记不力→吉卜力纠错失败:', correctDomain('记不力风格'));
console.assert(correctDomain('渲图成油画') === '渲染成油画', '渲图→渲染纠错失败:', correctDomain('渲图成油画'));

// 18. 风格渲染 op 解析
const rs1 = parseLocal('把我的画渲染成水彩风')!;
console.assert((rs1.ops.find(o => o.op === 'render_style') as { style?: string })?.style === '水彩', 'render_style 水彩解析错误:', JSON.stringify(rs1.ops));

const rs2 = parseLocal('申屠成水彩风')!;  // 误识别 → 纠错 → render_style
console.assert(rs2.ops.some(o => o.op === 'render_style' && (o as { style: string }).style === '水彩'), '纠错后未命中风格渲染:', JSON.stringify(rs2.ops));

const rs3 = parseLocal('去掉风格')!;
console.assert(rs3.ops.some(o => o.op === 'render_style' && (o as { style: string }).style === 'none'), '去掉风格→render_style none 失败:', JSON.stringify(rs3.ops));

const rs4 = parseLocal('来点吉卜力风格')!;
console.assert(rs4.ops.some(o => o.op === 'render_style' && (o as { style: string }).style === '吉卜力'), '吉卜力风格解析失败:', JSON.stringify(rs4.ops));

// 19. 「渲染成X」不被「染成→改成」同音规则误伤
console.assert(normalize('渲染成水彩') === '渲染成水彩', '渲染成被误伤:', normalize('渲染成水彩'));

// 20. 物体级 AI 重绘 regen
const rg1 = parseLocal('把那棵树变成真实的樱花树')!;
const regen1 = rg1.ops.find(o => o.op === 'regen') as { target?: { name?: string }; prompt?: string } | undefined;
console.assert(regen1?.target?.name === '树' && /樱花/.test(regen1?.prompt || ''), 'regen 解析错误:', JSON.stringify(rg1.ops));

const rg2 = parseLocal('把它变成一只真实的猫')!;
const regen2 = rg2.ops.find(o => o.op === 'regen') as { target?: { kind?: string } } | undefined;
console.assert(regen2?.target?.kind === 'last', '代词 regen 应指向最近对象:', JSON.stringify(rg2.ops));

// 「变成颜色」应走 modify 而非 regen
const rg3 = parseLocal('把房子变成蓝色')!;
console.assert(rg3.ops.some(o => o.op === 'modify') && !rg3.ops.some(o => o.op === 'regen'), '变成颜色应走 modify:', JSON.stringify(rg3.ops));

console.log(`\n${pass}/${pass + fail} 通过 (${pass + fail} 用例)`);
process.exit(fail ? 1 : 0);

/** L0 解析器冒烟测试：npx tsx client/test/parser.test.ts */
import { parseLocal, normalize } from '../src/voice/parser';

const cases: [string, boolean][] = [
  // [指令, 期望 L0 命中]
  ['画一个红色的圆', true],
  ['画一个圆', true],
  ['在左上角画一个大的红色圆形', true],
  ['画三颗星星', true],
  ['画个半径120的蓝色圆', true],
  ['画一条横线', true],
  ['画一个六边形', true],
  ['来一个绿色的爱心', true],
  ['写上七牛云，字号40', true],
  ['写上 你好世界', true],
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
  ['删除', true],
  ['把那个星星删掉', true],
  ['选中那个蓝色的方块', true],
  ['撤销', true],
  ['重做', true],
  ['清空画布', true],
  ['保存图片', true],
  ['背景换成深蓝色', true],
  ['帮助', true],
  ['画一个圆，然后改成红色，再大一点', true],
  // 同音容错
  ['华一个园形', true],
  ['搞一个紫色的三角形', true],
  // 应升级 LLM
  ['画一座房子，旁边有一棵树，天上有太阳和云', false],
  ['把整幅画变得更有秋天的感觉', false],
  ['在圆和方块之间画一条连接线', false],
];

let pass = 0, fail = 0;
for (const [text, expectLocal] of cases) {
  const r = parseLocal(text);
  const hit = r != null;
  const ok = hit === expectLocal;
  if (ok) pass++;
  else {
    fail++;
    console.log(`✗ "${text}" 期望${expectLocal ? 'L0 命中' : '升级 LLM'} 实际${hit ? 'L0' : 'LLM'}  norm="${normalize(text)}"`);
    if (r) console.log('   ops:', JSON.stringify(r.ops).slice(0, 200));
  }
}
// 关键语义抽查
const r1 = parseLocal('在左上角画一个大的红色圆形')!;
const add1 = r1.ops.find(o => o.op === 'add') as { props: Record<string, number | string> };
console.assert(add1.props.x === 190 && add1.props.y === 130, '位置解析错误', add1.props);
console.assert((add1.props.r as number) > 60, '大小修饰未生效', add1.props);
console.assert((add1.props.fill as string).startsWith('#e7'), '颜色解析错误', add1.props);

const r2 = parseLocal('画三颗星星')!;
console.assert(r2.ops.filter(o => o.op === 'add').length === 3, '数量词未生效');

const r3 = parseLocal('把红色的圆改成黄色')!;
const mod = r3.ops.find(o => o.op === 'modify') as { target: { kind: string; color?: string } };
console.assert(mod.target.kind === 'query' && mod.target.color === 'red', '目标查询解析错误', mod.target);

console.log(`\n${pass}/${pass + fail} 通过`);
process.exit(fail ? 1 : 0);

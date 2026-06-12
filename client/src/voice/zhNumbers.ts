/** 中文数词 → 阿拉伯数字（支持 零~万、两、点五），并把文本里的中文数字整体替换 */
const DIGIT: Record<string, number> = {
  零: 0, 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
};
const UNIT: Record<string, number> = { 十: 10, 百: 100, 千: 1000, 万: 10000 };

export function zhToNum(str: string): number | null {
  if (/^\d+(\.\d+)?$/.test(str)) return parseFloat(str);
  let total = 0, section = 0, cur = 0, valid = false;
  for (const ch of str) {
    if (ch in DIGIT) { cur = DIGIT[ch]; valid = true; }
    else if (ch === '十') { section += (cur || 1) * 10; cur = 0; valid = true; }
    else if (ch === '百' || ch === '千') { section += (cur || 1) * UNIT[ch]; cur = 0; valid = true; }
    else if (ch === '万') { total = (total + section + cur) * 10000; section = 0; cur = 0; valid = true; }
    else return null;
  }
  return valid ? total + section + cur : null;
}

/** 把句中的中文数字串替换为阿拉伯数字，便于后续正则提取 */
export function normalizeNumbers(text: string): string {
  return text.replace(/[零一二两三四五六七八九十百千万]+/g, m => {
    const n = zhToNum(m);
    return n == null ? m : String(n);
  });
}

/** 本地语音反馈（speechSynthesis），播报期间回调用于 ASR 静音防自激 */
let zhVoice: SpeechSynthesisVoice | null = null;

function pickVoice() {
  const vs = speechSynthesis.getVoices();
  zhVoice = vs.find(v => /zh[-_]CN/i.test(v.lang) && /婷|Xiaoxiao|Mei|Ting/i.test(v.name))
    ?? vs.find(v => /zh[-_]CN/i.test(v.lang)) ?? vs.find(v => /^zh/i.test(v.lang)) ?? null;
}
if (typeof speechSynthesis !== 'undefined') {
  pickVoice();
  speechSynthesis.onvoiceschanged = pickVoice;
}

export function speak(text: string, onBusy?: (busy: boolean) => void) {
  if (typeof speechSynthesis === 'undefined' || !text) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text);
  if (zhVoice) u.voice = zhVoice;
  u.lang = 'zh-CN'; u.rate = 1.15; u.pitch = 1.02; u.volume = 0.9;
  onBusy?.(true);
  const done = () => setTimeout(() => onBusy?.(false), 250); // 余音静默期
  u.onend = done; u.onerror = done;
  speechSynthesis.speak(u);
}

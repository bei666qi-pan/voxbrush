/**
 * 语音反馈（已停用文字转语音）。
 *
 * 原实现用浏览器 speechSynthesis 朗读确认语，带来三个问题：
 *  1) 默认音色机械生硬；
 *  2) 朗读声从扬声器漏入麦克风被 ASR 再次识别，形成「回声→再播报」的死循环（同一句反复播报）；
 *  3) 朗读期间靠 onend 回调解除麦克风静音，而 Chrome 的 speechSynthesis 在被打断/失焦时
 *     onend 常不触发，导致麦克风被永久静音、后续语音指令全部失效（表现为「画不出来」）。
 *
 * 现改为纯视觉字幕反馈（见 App 的 caption），不再产生任何音频，也不再静音麦克风。
 * 保留同名 speak() 仅为兼容；不发声、不静音。
 */
export function speak(_text: string, _onBusy?: (busy: boolean) => void) {
  /* no-op：反馈改由界面字幕呈现 */
}

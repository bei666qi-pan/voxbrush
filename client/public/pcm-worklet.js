/**
 * 把任意采样率的麦克风输入重采样为 16kHz Int16 PCM，20ms 一帧发回主线程。
 */
class PcmWorklet extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetRate = 16000;
    this.buf = [];
    this.acc = 0; // 重采样游标
    this.out = new Int16Array(320); // 20ms@16k
    this.outLen = 0;
  }
  process(inputs) {
    const ch = inputs[0]?.[0];
    if (!ch) return true;
    const ratio = sampleRate / this.targetRate;
    let level = 0;
    for (let i = 0; i < ch.length; i++) {
      const v = ch[i];
      level = Math.max(level, Math.abs(v));
      this.acc += 1;
      while (this.acc >= ratio) {
        this.acc -= ratio;
        const s = Math.max(-1, Math.min(1, v));
        this.out[this.outLen++] = s < 0 ? s * 0x8000 : s * 0x7fff;
        if (this.outLen === this.out.length) {
          this.port.postMessage({ pcm: this.out.buffer.slice(0), level }, []);
          this.outLen = 0;
        }
      }
    }
    return true;
  }
}
registerProcessor('pcm-worklet', PcmWorklet);

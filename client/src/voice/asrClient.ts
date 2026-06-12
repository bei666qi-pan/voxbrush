/**
 * 语音输入引擎（双引擎，统一接口）：
 *  - server: 麦克风 → AudioWorklet 重采样 16k PCM → WebSocket → sherpa-onnx 流式识别（默认，国内可用）
 *  - webspeech: 浏览器 Web Speech API（备用引擎）
 */
export interface AsrEvents {
  onPartial: (text: string) => void;
  onFinal: (text: string, asrMs?: number) => void;
  onLevel: (level: number) => void;
  onState: (state: 'connecting' | 'listening' | 'error' | 'closed', detail?: string) => void;
}

export interface AsrEngine {
  start(): Promise<void>;
  stop(): void;
  /** TTS 播报期间静音，防自激 */
  setMuted(muted: boolean): void;
  readonly kind: string;
}

export class ServerAsr implements AsrEngine {
  readonly kind = 'server';
  private ws: WebSocket | null = null;
  private ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private stream: MediaStream | null = null;
  private muted = false;
  private closed = false;

  constructor(private ev: AsrEvents) {}

  async start() {
    this.closed = false;
    this.ev.onState('connecting');
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: 1 },
    });
    this.ctx = new AudioContext();
    await this.ctx.audioWorklet.addModule('/pcm-worklet.js');
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.node = new AudioWorkletNode(this.ctx, 'pcm-worklet');
    src.connect(this.node);

    this.connectWs();

    this.node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; level: number }>) => {
      this.ev.onLevel(this.muted ? 0 : e.data.level);
      if (this.muted) return;
      if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(e.data.pcm);
    };
  }

  private connectWs() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws/asr`);
    this.ws.binaryType = 'arraybuffer';
    this.ws.onopen = () => this.ev.onState('listening');
    this.ws.onmessage = e => {
      try {
        const msg = JSON.parse(e.data as string);
        if (msg.type === 'partial') this.ev.onPartial(msg.text);
        else if (msg.type === 'final') this.ev.onFinal(msg.text, msg.ms);
        else if (msg.type === 'error') this.ev.onState('error', msg.message);
      } catch { /* ignore */ }
    };
    this.ws.onclose = () => {
      if (!this.closed) setTimeout(() => this.connectWs(), 1200); // 自动重连
    };
    this.ws.onerror = () => this.ev.onState('error', 'WebSocket 连接失败');
  }

  setMuted(m: boolean) {
    this.muted = m;
    if (m && this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify({ type: 'reset' }));
  }

  stop() {
    this.closed = true;
    this.ws?.close(); this.node?.disconnect();
    this.stream?.getTracks().forEach(t => t.stop());
    this.ctx?.close();
    this.ev.onState('closed');
  }
}

type SR = { new (): SpeechRecognitionLike };
interface SpeechRecognitionLike {
  lang: string; continuous: boolean; interimResults: boolean;
  onresult: ((e: { resultIndex: number; results: { isFinal: boolean; 0: { transcript: string } }[] }) => void) | null;
  onend: (() => void) | null; onerror: ((e: { error: string }) => void) | null;
  start(): void; stop(): void;
}

export class WebSpeechAsr implements AsrEngine {
  readonly kind = 'webspeech';
  private rec: SpeechRecognitionLike | null = null;
  private muted = false;
  private closed = false;
  private segStart = 0;
  constructor(private ev: AsrEvents) {}

  async start() {
    const Ctor = (window as unknown as Record<string, SR>).SpeechRecognition
      ?? (window as unknown as Record<string, SR>).webkitSpeechRecognition;
    if (!Ctor) throw new Error('此浏览器不支持 Web Speech API');
    const rec = new Ctor();
    rec.lang = 'zh-CN'; rec.continuous = true; rec.interimResults = true;
    rec.onresult = e => {
      if (this.muted) return;
      const res = e.results[e.results.length - 1];
      const text = res[0].transcript.trim();
      if (!this.segStart) this.segStart = Date.now();
      if (res.isFinal) { this.ev.onFinal(text, Date.now() - this.segStart); this.segStart = 0; }
      else this.ev.onPartial(text);
    };
    rec.onend = () => { if (!this.closed) try { rec.start(); } catch { /* busy */ } };
    rec.onerror = e => this.ev.onState('error', `WebSpeech: ${e.error}`);
    rec.start();
    this.rec = rec;
    this.ev.onState('listening');
  }
  setMuted(m: boolean) { this.muted = m; }
  stop() { this.closed = true; this.rec?.stop(); this.ev.onState('closed'); }
}

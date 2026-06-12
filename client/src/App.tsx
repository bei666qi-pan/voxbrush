import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOps, initialScene, render, sceneBrief } from './engine/scene';
import { CANVAS_H, CANVAS_W, Op, SceneState } from './engine/types';
import { needsVision, parseLocal } from './voice/parser';
import { AsrEngine, ServerAsr, WebSpeechAsr } from './voice/asrClient';
import { speak } from './voice/tts';
import { callAgentStream } from './agent/client';

type Lane = 'L0 本地' | 'L1 大模型' | 'L2 多模态';
interface LogItem { id: number; text: string; lane?: Lane; ops?: number; ms?: number; asrMs?: number; firstMs?: number; err?: string; }

const HELP_LINES = [
  '「画一个红色的圆」「在左上角画三颗星星」',
  '「写上 七牛云，字号四十」「背景换成深蓝色」',
  '「大一点 / 往左移五十 / 改成绿色 / 旋转四十五度」',
  '「画一座房子，旁边一棵树，天上一个太阳」（AI 拆解）',
  '「撤销 / 重做 / 清空 / 保存图片」',
];

let logSeq = 0;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState>(initialScene());
  const undoStack = useRef<SceneState[]>([]);
  const redoStack = useRef<SceneState[]>([]);
  const engineRef = useRef<AsrEngine | null>(null);
  const busyRef = useRef(false);

  const [started, setStarted] = useState(false);
  const [engineKind, setEngineKind] = useState<'server' | 'webspeech'>('server');
  const [state, setState] = useState<string>('未连接');
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [thinking, setThinking] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [objCount, setObjCount] = useState(0);

  // ---------- 渲染循环 ----------
  useEffect(() => {
    let raf = 0;
    const loop = () => {
      const c = canvasRef.current;
      if (c) {
        const ctx = c.getContext('2d')!;
        const dpr = window.devicePixelRatio || 1;
        if (c.width !== CANVAS_W * dpr) { c.width = CANVAS_W * dpr; c.height = CANVAS_H * dpr; }
        render(ctx, sceneRef.current, dpr);
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  const snapshotState = () => JSON.parse(JSON.stringify({ ...sceneRef.current })) as SceneState;

  const say = useCallback((text: string) => {
    speak(text, busy => {
      busyRef.current = busy;
      engineRef.current?.setMuted(busy);
    });
  }, []);

  const pushLog = (item: Omit<LogItem, 'id'>) =>
    setLogs(ls => [...ls.slice(-30), { ...item, id: ++logSeq }]);

  // ---------- 执行 Ops ----------
  const execute = useCallback((ops: Op[], reply?: string) => {
    const s = sceneRef.current;
    const t0 = performance.now();
    // undo/redo 特殊处理
    const rest: Op[] = [];
    for (const o of ops) {
      if (o.op === 'undo') {
        const prev = undoStack.current.pop();
        if (prev) { redoStack.current.push(snapshotState()); sceneRef.current = prev; say('已撤销'); }
        else say('没有可以撤销的了');
      } else if (o.op === 'redo') {
        const next = redoStack.current.pop();
        if (next) { undoStack.current.push(snapshotState()); sceneRef.current = next; say('已重做'); }
        else say('没有可以重做的了');
      } else rest.push(o);
    }
    if (rest.length) {
      undoStack.current.push(snapshotState());
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      const { effects } = applyOps(sceneRef.current, rest);
      if (effects.save) downloadPng();
      if (effects.help) { setShowHelp(true); say('试试这些指令：画一个红色的圆，或者说，画一座房子和一棵树'); }
      const extra = effects.say?.length ? effects.say.join('，') : undefined;
      const final = reply ?? extra;
      if (final) say(final);
      else if (extra) say(extra);
    } else if (reply) {
      say(reply);
    }
    setObjCount(sceneRef.current.nodes.length);
    return Math.round(performance.now() - t0);
  }, [say]);

  const downloadPng = () => {
    const c = canvasRef.current; if (!c) return;
    const a = document.createElement('a');
    a.download = `voxbrush-${Date.now()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  };

  // ---------- 指令处理主流程 ----------
  const handleUtterance = useCallback(async (text: string, asrMs?: number) => {
    const trimmed = text.trim();
    if (trimmed.length < 2) return; // 噪声过滤
    setPartial('');
    setShowHelp(false);

    const t0 = performance.now();
    const local = parseLocal(trimmed);
    if (local) {
      const ms = execute(local.ops, local.reply);
      pushLog({ text: trimmed, lane: 'L0 本地', ops: local.ops.length, ms: Math.round(performance.now() - t0) + ms, asrMs });
      return;
    }

    // 升级 L1/L2（v1.1：SSE 流式拆解，边生成边逐笔绘制）
    setThinking(true);
    const vision = needsVision(trimmed) && sceneRef.current.nodes.length > 0;
    const lane: Lane = vision ? 'L2 多模态' : 'L1 大模型';
    let snapshot: string | undefined;
    if (vision && canvasRef.current) {
      const small = document.createElement('canvas');
      small.width = 480; small.height = 300;
      small.getContext('2d')!.drawImage(canvasRef.current, 0, 0, 480, 300);
      snapshot = small.toDataURL('image/jpeg', 0.7);
    }

    let started = false, opCount = 0, firstMs = 0;
    const beginBatch = () => {
      undoStack.current.push(JSON.parse(JSON.stringify(sceneRef.current)) as SceneState);
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
    };
    const applyStreamOp = (op: Op) => {
      const { effects } = applyOps(sceneRef.current, [op]);
      if (effects.save) downloadPng();
      setObjCount(sceneRef.current.nodes.length);
    };

    try {
      await callAgentStream(trimmed, sceneBrief(sceneRef.current), snapshot, ev => {
        if (ev.type === 'op' && ev.op) {
          if (!started) { beginBatch(); started = true; firstMs = Math.round(performance.now() - t0); }
          applyStreamOp(ev.op);
          opCount++;
        } else if (ev.type === 'done') {
          const rest = (ev.ops ?? []).slice(ev.emitted ?? opCount);
          if (rest.length) {
            if (!started) { beginBatch(); started = true; }
            rest.forEach(applyStreamOp);
            opCount += rest.length;
          }
          if (opCount || ev.reply) say(ev.reply ?? '画好了');
          pushLog({ text: trimmed, lane, ops: opCount, ms: Math.round(performance.now() - t0), firstMs, asrMs });
        } else if (ev.type === 'error') {
          pushLog({ text: trimmed, lane, err: ev.message });
          say('云端大脑暂时联系不上，简单指令还是可以用的');
        }
      });
    } catch (e) {
      pushLog({ text: trimmed, lane, err: (e as Error).message });
      say('这个指令我没处理好，换个说法试试');
    } finally {
      setThinking(false);
    }
  }, [execute, say]);

  const handleRef = useRef(handleUtterance);
  handleRef.current = handleUtterance;

  // ---------- 启动语音 ----------
  const startVoice = useCallback(async (kind: 'server' | 'webspeech') => {
    engineRef.current?.stop();
    const ev = {
      onPartial: (t: string) => setPartial(t),
      onFinal: (t: string, ms?: number) => handleRef.current(t, ms),
      onLevel: (l: number) => setLevel(l),
      onState: (s: string, d?: string) => setState(d ? `${s}: ${d}` : s),
    };
    const engine = kind === 'server' ? new ServerAsr(ev) : new WebSpeechAsr(ev);
    try {
      await engine.start();
      engineRef.current = engine;
      setEngineKind(kind);
      setStarted(true);
      say('声笔已就绪，直接说出你想画的，比如：画一个红色的圆');
    } catch (e) {
      setState(`启动失败: ${(e as Error).message}`);
      if (kind === 'server') {
        try { await startVoice('webspeech'); } catch { /* both failed */ }
      }
    }
  }, [say]);

  const laneColor = (lane?: Lane) =>
    lane === 'L0 本地' ? 'var(--ok)' : lane === 'L1 大模型' ? 'var(--q-blue)' : '#9b59b6';

  return (
    <div className="app">
      <header className="topbar">
        <img src="/logo.svg" alt="声笔 VoxBrush" className="logo" />
        <div className="spacer" />
        <span className={`status ${state === 'listening' ? 'on' : ''}`}>
          <span className="dot" />{started ? (state === 'listening' ? '正在聆听' : state) : '待启动'}
        </span>
        <div className="meter"><div className="meter-fill" style={{ width: `${Math.min(100, level * 260)}%` }} /></div>
        <span className="chip">{engineKind === 'server' ? '本地流式 ASR' : 'Web Speech'}</span>
        <span className="chip">对象 {objCount}</span>
      </header>

      <main className="stage">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} style={{ width: CANVAS_W, height: CANVAS_H }} />
          {!started && (
            <div className="overlay">
              <img src="/favicon.svg" width={84} alt="" />
              <h1>声笔 VoxBrush</h1>
              <p>纯语音控制的 AI 绘图工具 —— 不碰鼠标，不碰键盘，开口即画。</p>
              <button className="primary" onClick={() => startVoice('server')}>
                🎙️ 授权麦克风并开始（唯一一次点击）
              </button>
              <small>授权后全程语音操作 · 说"帮助"查看能力</small>
            </div>
          )}
          {showHelp && started && (
            <div className="help">
              <b>你可以这样说：</b>
              {HELP_LINES.map(l => <div key={l}>{l}</div>)}
            </div>
          )}
          {thinking && <div className="thinking">🧠 AI 正在拆解指令…</div>}
          {partial && <div className="partial">{partial}<span className="caret" /></div>}
        </div>

        <aside className="console">
          <div className="console-title">指令流水 <small>(语音→理解→执行 全链路延迟)</small></div>
          <div className="log-list">
            {logs.length === 0 && <div className="log-empty">等待你的第一条语音指令…</div>}
            {[...logs].reverse().map(l => (
              <div className="log" key={l.id}>
                <div className="log-text">“{l.text}”</div>
                <div className="log-meta">
                  {l.lane && <span className="badge" style={{ background: laneColor(l.lane) }}>{l.lane}</span>}
                  {l.asrMs != null && <span className="kv">ASR {l.asrMs}ms</span>}
                  {!!l.firstMs && <span className="kv">首笔 {l.firstMs}ms</span>}
                  {l.ms != null && <span className="kv">理解+执行 {l.ms}ms</span>}
                  {l.ops != null && <span className="kv">{l.ops} ops</span>}
                  {l.err && <span className="kv err">{l.err.slice(0, 60)}</span>}
                </div>
              </div>
            ))}
          </div>
          <footer className="foot">
            七牛云校招挑战 · <a href="https://github.com/bei666qi-pan/voxbrush" target="_blank" rel="noreferrer">GitHub</a> · <a href="/api/health" target="_blank">健康自检</a>
          </footer>
        </aside>
      </main>
    </div>
  );
}

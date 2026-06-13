import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOps, getHistory, initialScene, insertImageNode, pushHistory, render, sceneBrief, setRenderLayer, takeRenderLayer } from './engine/scene';
import { CANVAS_H, CANVAS_W, Op, SceneState } from './engine/types';
import { correctDomain, isReviewOrBeautify, needsVision, parseLocal } from './voice/parser';
import { AsrEngine, ServerAsr, WebSpeechAsr } from './voice/asrClient';
import { callAgentStream } from './agent/client';

type Lane = 'L0 本地' | 'L1 大模型' | 'L2 多模态';
interface LogItem { id: number; text: string; lane?: Lane; ops?: number; ms?: number; asrMs?: number; firstMs?: number; err?: string; corrected?: string; }

const HELP_LINES = [
  '「画一个红色的圆」「在左上角画三颗星星」',
  '「写上 七牛云，字号四十」「背景换成深蓝色」',
  '「大一点 / 往左移五十 / 改成绿色 / 旋转四十五度」',
  '「画一座房子，旁边一棵树，天上一个太阳」（AI 拆解）',
  '「再来一棵 / 一样的颜色」（有记忆的连续创作）',
  '「记住这个叫小屋」→「在右边画两个小屋」（语音宏）',
  '「评价一下我的画」「帮我美化构图」（AI 评画）',
  '「把我的画渲染成水彩风」「来点吉卜力风格」（风格渲染，矢量仍可改）',
  '「把那棵树变成真实的樱花树」（物体级 AI 重绘）',
  '「撤销 / 重做 / 清空 / 保存图片」',
];

let logSeq = 0;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState>(initialScene());
  const undoStack = useRef<SceneState[]>([]);
  const redoStack = useRef<SceneState[]>([]);
  const engineRef = useRef<AsrEngine | null>(null);
  const captionTimer = useRef<number | undefined>(undefined);

  const [started, setStarted] = useState(false);
  const [engineKind, setEngineKind] = useState<'server' | 'webspeech'>('server');
  const [state, setState] = useState<string>('未连接');
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [thinking, setThinking] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [objCount, setObjCount] = useState(0);
  const [caption, setCaption] = useState('');

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

  // 反馈改为屏幕字幕：不发声、不静音麦克风（彻底消除机器音、回声自激与「静音卡死导致画不出」）
  const say = useCallback((text: string) => {
    if (!text) return;
    setCaption(text);
    window.clearTimeout(captionTimer.current);
    captionTimer.current = window.setTimeout(() => setCaption(''), 2600);
  }, []);

  const pushLog = (item: Omit<LogItem, 'id'>) =>
    setLogs(ls => [...ls.slice(-30), { ...item, id: ++logSeq }]);

  // ---------- 执行 Ops ----------
  const runGenerateImages = useCallback(async (items: NonNullable<ReturnType<typeof applyOps>['effects']['generateImage']>) => {
    for (const item of items ?? []) {
      say(item.as === 'background' ? '正在生成背景，请稍等' : '正在生成图片，请稍等');
      try {
        const res = await fetch('/api/image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt: item.prompt,
            // Seedream 4.0 要求单边 ≥768；1280x800 与画布 8:5 同比
            size: item.as === 'background' ? '1280x800' : '1024x1024',
          }),
          signal: AbortSignal.timeout(90000),
        });
        const json = await res.json().catch(() => ({}));
        if (!res.ok || !json.url) {
          say('图片生成失败了，我用素材库来画');
          continue;
        }
        insertImageNode(sceneRef.current, json.url, {
          as: item.as,
          x: item.x,
          y: item.y,
          w: item.w ?? (item.as === 'background' ? CANVAS_W : 200),
          h: item.h ?? (item.as === 'background' ? CANVAS_H : 150),
        });
        // 物体级重绘：AI 图就位后删除被替换的原对象
        if (item.replaceId) sceneRef.current.nodes = sceneRef.current.nodes.filter(n => n.id !== item.replaceId);
        setObjCount(sceneRef.current.nodes.length);
      } catch {
        say('图片生成超时了，继续用矢量素材');
      }
    }
  }, [say]);

  // 风格化渲染：截当前矢量层快照 → img2img → 铺为 z=-50 渲染层（矢量对象保留可编辑）
  const runRenderStyle = useCallback(async (rs: { style: string; strength?: number }) => {
    if (sceneRef.current.nodes.filter(n => n.name !== '风格渲染').length === 0) {
      say('先画点东西，再渲染风格吧'); return;
    }
    setThinking(true);
    say(`正在渲染${rs.style}风格，大约十秒`);
    // 取出旧渲染层 → 等一帧让画布只剩矢量层 → 截快照作条件图
    const removed = takeRenderLayer(sceneRef.current);
    await new Promise<void>(r => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    let snapshot: string | undefined;
    const c = canvasRef.current;
    if (c) {
      const small = document.createElement('canvas');
      small.width = 960; small.height = 600;
      small.getContext('2d')!.drawImage(c, 0, 0, 960, 600);
      snapshot = small.toDataURL('image/jpeg', 0.85);
    }
    const sceneDesc = sceneRef.current.nodes.map(n => n.name || n.asset || n.shape).join('、');
    try {
      const res = await fetch('/api/render', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: snapshot, style: rs.style, sceneDesc }),
        signal: AbortSignal.timeout(120000),
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok || !json.url) {
        if (removed) sceneRef.current.nodes.unshift(removed); // 还原旧渲染层
        say('风格渲染暂时不可用，画面保持不变');
        return;
      }
      setRenderLayer(sceneRef.current, json.url);
      setObjCount(sceneRef.current.nodes.length);
      say(`${rs.style}风格渲染好了，矢量对象还能继续修改`);
    } catch {
      if (removed) sceneRef.current.nodes.unshift(removed);
      say('风格渲染超时了，画面保持不变');
    } finally {
      setThinking(false);
    }
  }, [say]);

  const execute = useCallback(async (ops: Op[], reply?: string) => {
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
    let applyResult: ReturnType<typeof applyOps> | null = null;
    if (rest.length) {
      undoStack.current.push(snapshotState());
      if (undoStack.current.length > 100) undoStack.current.shift();
      redoStack.current = [];
      applyResult = applyOps(sceneRef.current, rest);
      const { effects } = applyResult;
      if (effects.generateImage?.length) await runGenerateImages(effects.generateImage);
      if (effects.renderStyle) await runRenderStyle(effects.renderStyle);
      if (effects.save) downloadPng();
      if (effects.help) { setShowHelp(true); say('试试这些指令：画一个红色的圆，或者说，画一座房子和一棵树'); }
      const extra = effects.say?.length ? effects.say.join('，') : undefined;
      const final = reply ?? extra;
      if (final) say(final);
    } else if (reply) {
      say(reply);
    }
    setObjCount(sceneRef.current.nodes.length);
    return { ms: Math.round(performance.now() - t0), applyResult };
  }, [say, runGenerateImages, runRenderStyle]);

  const downloadPng = () => {
    const c = canvasRef.current; if (!c) return;
    const a = document.createElement('a');
    a.download = `voxbrush-${Date.now()}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  };

  // 暴露场景引用给宏系统
  useEffect(() => {
    (window as unknown as Record<string, unknown>).__voxbrush_scene = sceneRef.current;
  });

  // ---------- 指令处理主流程 ----------
  const handleUtterance = useCallback(async (text: string, asrMs?: number) => {
    const raw = text.trim();
    if (raw.length < 2) return; // 噪声过滤
    setPartial('');
    setShowHelp(false);

    // 领域同音纠错（生图/水彩/渲染/吉卜力…）：下游统一用纠错后的文本，HUD 展示「原文 → 纠错后」
    const trimmed = correctDomain(raw);
    const correctedNote = trimmed !== raw ? `${raw} → ${trimmed}` : undefined;

    const t0 = performance.now();

    // 评画/美化 → 必须走 L2 多模态
    if (isReviewOrBeautify(trimmed) && sceneRef.current.nodes.length > 0) {
      setThinking(true);
      const snapshot = canvasRef.current?.toDataURL('image/jpeg', 0.7);
      try {
        await callAgentStream(trimmed, sceneBrief(sceneRef.current), snapshot, async ev => {
          if (ev.type === 'op' && ev.op) {
            // 美化：执行修改 ops（逐笔可见）
            if (ev.op.op === 'modify' || ev.op.op === 'add' || ev.op.op === 'delete') {
              // 首次美化操作前入撤销栈
              if (!undoStack.current.length || undoStack.current[undoStack.current.length - 1] !== snapshotState()) {
                undoStack.current.push(snapshotState());
                if (undoStack.current.length > 100) undoStack.current.shift();
                redoStack.current = [];
              }
              const { effects } = applyOps(sceneRef.current, [ev.op]);
              if (effects.generateImage?.length) await runGenerateImages(effects.generateImage);
              if (effects.renderStyle) await runRenderStyle(effects.renderStyle);
              setObjCount(sceneRef.current.nodes.length);
            } else if (ev.op.op === 'say') {
              say(ev.op.text);
            }
          } else if (ev.type === 'done') {
            if (ev.reply) say(ev.reply);
            pushLog({ text: trimmed, lane: 'L2 多模态', ops: ev.ops?.length ?? 0, ms: Math.round(performance.now() - t0), asrMs, corrected: correctedNote });
          } else if (ev.type === 'error') {
            pushLog({ text: trimmed, lane: 'L2 多模态', err: ev.message, corrected: correctedNote });
            say('云端大脑暂时联系不上，简单指令还是可以用的');
          }
        }, getHistory());
      } catch (e) {
        pushLog({ text: trimmed, lane: 'L2 多模态', err: (e as Error).message, corrected: correctedNote });
        say('这个指令我没处理好，换个说法试试');
      } finally {
        setThinking(false);
      }
      return;
    }

    const local = parseLocal(trimmed);
    if (local) {
      const { ms, applyResult } = await execute(local.ops, local.reply);
      // 使用 execute() 内部的 applyOps 结果，确保 lastAdd/objectIds 正确反映本轮操作
      pushHistory({
        utterance: trimmed,
        lastAdd: applyResult?.lastAdd,
        objectIds: applyResult?.objectIds ?? [],
        opsSummary: local.ops.map(o => o.op).join(','),
      });
      pushLog({ text: trimmed, lane: 'L0 本地', ops: local.ops.length, ms: Math.round(performance.now() - t0) + ms, asrMs, corrected: correctedNote });
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
    const applyStreamOp = async (op: Op) => {
      const { effects, lastAdd, objectIds: ids } = applyOps(sceneRef.current, [op]);
      if (effects.generateImage?.length) await runGenerateImages(effects.generateImage);
      if (effects.renderStyle) await runRenderStyle(effects.renderStyle);
      if (effects.save) downloadPng();
      setObjCount(sceneRef.current.nodes.length);
      return { lastAdd, ids };
    };

    // 本轮收集（用于历史记录）
    let roundLastAdd: ReturnType<typeof applyOps>['lastAdd'] = undefined;
    const roundIds: string[] = [];

    try {
      await callAgentStream(trimmed, sceneBrief(sceneRef.current), snapshot, async ev => {
        if (ev.type === 'op' && ev.op) {
          if (!started) { beginBatch(); started = true; firstMs = Math.round(performance.now() - t0); }
          const r = await applyStreamOp(ev.op);
          if (r.lastAdd) roundLastAdd = r.lastAdd;
          if (r.ids) roundIds.push(...r.ids);
          opCount++;
        } else if (ev.type === 'done') {
          const rest = (ev.ops ?? []).slice(ev.emitted ?? opCount);
          if (rest.length) {
            if (!started) { beginBatch(); started = true; }
            for (const o of rest) {
              const r = await applyStreamOp(o);
              if (r.lastAdd) roundLastAdd = r.lastAdd;
              if (r.ids) roundIds.push(...r.ids);
            }
            opCount += rest.length;
          }
          // 记录历史
          pushHistory({
            utterance: trimmed,
            lastAdd: roundLastAdd,
            objectIds: roundIds,
            opsSummary: (ev.ops ?? []).map((o: Op) => o.op).join(','),
          });
          if (opCount || ev.reply) say(ev.reply ?? '画好了');
          pushLog({ text: trimmed, lane, ops: opCount, ms: Math.round(performance.now() - t0), firstMs, asrMs, corrected: correctedNote });
        } else if (ev.type === 'error') {
          pushLog({ text: trimmed, lane, err: ev.message, corrected: correctedNote });
          say('云端大脑暂时联系不上，简单指令还是可以用的');
        }
      }, getHistory());
    } catch (e) {
      pushLog({ text: trimmed, lane, err: (e as Error).message, corrected: correctedNote });
      say('这个指令我没处理好，换个说法试试');
    } finally {
      setThinking(false);
    }
  }, [execute, say, runGenerateImages, runRenderStyle]);

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
          {caption && <div className="caption">{caption}</div>}
          {partial && <div className="partial">{partial}<span className="caret" /></div>}
        </div>

        <aside className="console">
          <div className="console-title">指令流水 <small>(语音→理解→执行 全链路延迟)</small></div>
          <div className="log-list">
            {logs.length === 0 && <div className="log-empty">等待你的第一条语音指令…</div>}
            {[...logs].reverse().map(l => (
              <div className="log" key={l.id}>
                <div className="log-text">“{l.text}”</div>
                {l.corrected && <div className="log-fix" title="领域同音纠错">🔧 {l.corrected}</div>}
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

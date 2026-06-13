import { useCallback, useEffect, useRef, useState } from 'react';
import { applyOps, getHistory, initialScene, insertImageNode, pushHistory, render, sceneBrief, setRenderLayer, takeRenderLayer } from './engine/scene';
import { CANVAS_H, CANVAS_W, Op, SceneState } from './engine/types';
import { correctDomain, isReviewOrBeautify, needsVision, parseLocal } from './voice/parser';
import { AsrEngine, ServerAsr, WebSpeechAsr } from './voice/asrClient';
import { callAgentStream } from './agent/client';

type Lane = 'L0 本地' | 'L1 大模型' | 'L2 多模态';
interface LogItem { id: number; text: string; lane?: Lane; ops?: number; ms?: number; asrMs?: number; firstMs?: number; err?: string; corrected?: string; }

// 面向用户的友好通道名（淡化 L0/L1/L2 技术术语）
const LANE_LABEL: Record<Lane, string> = {
  'L0 本地': '即时响应',
  'L1 大模型': 'AI 构图',
  'L2 多模态': '看图理解',
};

// 帮助卡片：图标 + 文案，比纯文字列表更有产品感
const HELP_ITEMS: { ico: string; html: string }[] = [
  { ico: '✏️', html: '“画一个红色的圆” · “在左上角画三颗星星”' },
  { ico: '🔤', html: '“写上七牛云，字号四十” · “背景换成深蓝色”' },
  { ico: '🎚️', html: '“大一点” · “往左移五十” · “改成绿色” · “旋转四十五度”' },
  { ico: '🏠', html: '“画一座房子，旁边一棵树，天上一个太阳”（自动拆解构图）' },
  { ico: '🔄', html: '“再来一棵” · “一样的颜色”（记得上一步，连续创作）' },
  { ico: '📦', html: '“记住这个叫小屋” → “在右边画两个小屋”（语音快捷组合）' },
  { ico: '🎨', html: '“评价一下我的画” · “帮我美化构图”（AI 逐笔优化）' },
  { ico: '🖌️', html: '“渲染成水彩风” · “来点吉卜力风格”（风格化，原图仍可改）' },
  { ico: '🪄', html: '“把那棵树变成真实的樱花树”（只重绘指定的那一个）' },
  { ico: '↩️', html: '“撤销” · “重做” · “清空” · “保存图片”' },
];

// 首屏示例气泡
const EXAMPLE_CHIPS = ['画一个红色的圆', '画一座房子和一棵树', '渲染成水彩风', '写上七牛云'];

let logSeq = 0;

export default function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sceneRef = useRef<SceneState>(initialScene());
  const undoStack = useRef<SceneState[]>([]);
  const redoStack = useRef<SceneState[]>([]);
  const engineRef = useRef<AsrEngine | null>(null);
  const captionTimer = useRef<number | undefined>(undefined);

  const [started, setStarted] = useState(false);
  const [authorizing, setAuthorizing] = useState(false);
  const [engineKind, setEngineKind] = useState<'server' | 'webspeech'>('server');
  const [state, setState] = useState<string>('未连接');
  const [level, setLevel] = useState(0);
  const [partial, setPartial] = useState('');
  const [logs, setLogs] = useState<LogItem[]>([]);
  const [thinking, setThinking] = useState(false);
  const [showHelp, setShowHelp] = useState(true);
  const [showTech, setShowTech] = useState(false); // 技术细节默认折叠，淡化术语
  const [objCount, setObjCount] = useState(0);
  const [caption, setCaption] = useState('');

  // 是否正在聆听（用于动态文案与状态点）
  const listening = started && state === 'listening';

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
      say('风格渲染超时了、画面保持不变');
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

  // 暴露场景引用给它系统
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
    if (kind === 'server') setAuthorizing(true);
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
      setAuthorizing(false);
      say('声笔已就绪，直接说出你想画的，比如：画一个红色的圆');
    } catch (e) {
      setState(`启动失败: ${(e as Error).message}`);
      if (kind === 'server') {
        try { await startVoice('webspeech'); } catch { setAuthorizing(false); }
      } else {
        setAuthorizing(false);
      }
    }
  }, [say]);

  const laneColor = (lane?: Lane) =>
    lane === 'L0 本地' ? 'var(--ok)' : lane === 'L1 大模型' ? 'var(--brand)' : 'var(--violet)';

  // 动态状态文案：未启动 → 授权中 → 聆听中 / 处理中
  const statusText = !started
    ? (authorizing ? '正在请求麦克风…' : '点击开始')
    : thinking ? '正在思考…'
    : listening ? '正在聆听'
    : state;

  return (
    <div className="app">
      <header className="topbar">
        <img src="/logo.svg" alt="声笔 VoxBrush" className="logo" />
        <div className="spacer" />
        <span className={`status ${listening ? 'on' : ''}`}>
          <span className="dot" />{statusText}
        </span>
        {started && (
          <div className="meter" title="麦克风音量">
            <div className="meter-fill" style={{ width: `${Math.min(100, level * 260)}%` }} />
          </div>
        )}
        <span className="chip"><span className="chip-ico">🎙️</span>{engineKind === 'server' ? '语音引擎' : '浏览器语音'}</span>
        <span className="chip">画面 {objCount} 个元素</span>
      </header>

      <main className="stage">
        <div className="canvas-wrap">
          <canvas ref={canvasRef} style={{ width: CANVAS_W, height: CANVAS_H }} />
          {!started && (
            <div className="overlay">
              <span className="overlay-badge"><span className="pip" />七牛云校招挑战作品 · 纯语音 AI 绘图</span>
              <img className="overlay-logo" src="/favicon.svg" width={80} alt="" />
              <h1>声笔 VoxBrush</h1>
              <p>不碰鼠标，不碰键盘 —— 开口即画。<br />授权一次麦克风，之后全程用语音创作。</p>
              <button className="primary" disabled={authorizing} onClick={() => startVoice('server')}>
                {authorizing ? (
                  <><span className="mic-pulse" />正在请求麦克风权限…</>
                ) : (
                  <><span className="mic-ring">🎙️</span>开启麦克风，开始创作</>
                )}
              </button>
              <small>{authorizing ? '请在浏览器弹窗中点击“允许”' : '仅需授权一次 · 随时说“帮助”查看更多玩法'}</small>
              {!authorizing && (
                <div className="overlay-hints">
                  {EXAMPLE_CHIPS.map(c => <span className="eg" key={c}>“{c}”</span>)}
                </div>
              )}
            </div>
          )}
          {showHelp && started && (
            <div className="help">
              <div className="help-head">
                <b>试试这样说</b>
                <button className="help-close" title="收起" onClick={() => setShowHelp(false)}>×</button>
              </div>
              <div className="help-grid">
                {HELP_ITEMS.map(it => (
                  <div className="row" key={it.html}>
                    <span className="ico">{it.ico}</span>
                    <span className="txt">{it.html}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
          {thinking && <div className="thinking"><span className="spin" />AI 正在理解你的想法…</div>}
          {caption && <div className="caption">{caption}</div>}
          {partial && <div className="partial"><span className="lead">听到</span>{partial}<span className="caret" /></div>}
        </div>

        <aside className="console">
          <div className="console-title">
            <span className="ct-ico">✨</span>
            创作记录
            <small>每一句话如何变成画面</small>
          </div>
          <div className="log-list">
            {logs.length === 0 && (
              <div className="log-empty">
                <span className="le-ico">🎤</span>
                说出你的第一句话，<br />这里会记录每次创作的过程
              </div>
            )}
            {[...logs].reverse().map(l => (
              <div className="log" key={l.id}>
                <div className="log-text">“{l.text}”</div>
                {l.corrected && <div className="log-fix" title="语音识别智能纠错">✓ 已纠正：{l.corrected}</div>}
                <div className="log-meta">
                  {l.lane && (
                    <span className="badge" style={{ background: laneColor(l.lane) }}>
                      <span className="bdot" />{LANE_LABEL[l.lane]}
                    </span>
                  )}
                  {l.ms != null && <span className="kv">{(l.ms / 1000).toFixed(1)}s</span>}
                  {l.err && <span className="kv err">未能完成</span>}
                  {/* 工程指标仅在展开技术细节时显示 */}
                  {showTech && l.asrMs != null && <span className="kv">识别 {l.asrMs}ms</span>}
                  {showTech && !!l.firstMs && <span className="kv">首笔 {l.firstMs}ms</span>}
                  {showTech && l.ops != null && <span className="kv">{l.ops} ops</span>}
                  {showTech && l.err && <span className="kv err">{l.err.slice(0, 60)}</span>}
                </div>
              </div>
            ))}
          </div>
          {logs.length > 0 && (
            <div className={`tech-toggle ${showTech ? 'open' : ''}`} onClick={() => setShowTech(t => !t)}>
              <span>{showTech ? '隐藏技术细节' : '查看技术细节'}（识别耗时 · 首笔延迟 · 原语数）</span>
              <span className="tt-arrow">⌄</span>
            </div>
          )}
          <footer className="foot">
            七牛云校招挑战
            <span className="sep">·</span>
            <a href="https://github.com/bei666qi-pan/voxbrush" target="_blank" rel="noreferrer">GitHub</a>
            <span className="sep">·</span>
            <a href="/api/health" target="_blank">运行状态</a>
          </footer>
        </aside>
      </main>
    </div>
  );
}

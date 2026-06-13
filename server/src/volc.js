/**
 * 火山引擎鉴权与方舟(Ark)客户端
 * - 仅持有 AK/SK 时：以火山 SigV4 签名调用 open.volcengineapi.com GetApiKey，
 *   动态铸造临时 Ark API Key（内存缓存，过期前自动续期）。
 * - 设置 ARK_API_KEY 环境变量时直接使用。
 * - 模型 ID 自动探测：按候选列表逐一试调，缓存首个可用项。
 */
import crypto from 'node:crypto';

const ARK_HOST = process.env.ARK_HOST || 'ark.cn-beijing.volces.com';
const OPEN_HOST = 'open.volcengineapi.com';
const REGION = 'cn-beijing';

const TEXT_CANDIDATES = (process.env.ARK_MODEL ? [process.env.ARK_MODEL] : []).concat([
  'doubao-seed-1-6-flash-250828',
  'doubao-seed-1-6-flash-250615',
  'doubao-seed-1-6-250615',
  'doubao-1-5-lite-32k-250115',
  'doubao-1-5-pro-32k-250115',
]);
const VISION_CANDIDATES = (process.env.ARK_VISION_MODEL ? [process.env.ARK_VISION_MODEL] : []).concat([
  'doubao-seed-1-6-flash-250828',
  'doubao-seed-1-6-flash-250615',
  'doubao-seed-1-6-250615',
  'doubao-1-5-vision-pro-32k-250115',
]);
const IMAGE_CANDIDATES = (process.env.ARK_IMAGE_MODEL ? [process.env.ARK_IMAGE_MODEL] : []).concat([
  'doubao-seedream-4-0-250828',   // 本账号实测可用（文生图 + img2img）
  'doubao-seedream-4-0-250415',
  'doubao-seedream-4-0',
  'doubao-seedream-3-0-t2i-250415',
  'doubao-seedream-3-0-t2i',
]);

function hmac(key, data) { return crypto.createHmac('sha256', key).update(data, 'utf8').digest(); }
function sha256hex(data) { return crypto.createHash('sha256').update(data, 'utf8').digest('hex'); }

/** 火山引擎 OpenAPI SigV4 签名请求（通用：支持 GET/POST + 自定义 host/path/service/region/query） */
export async function signedOpenApiRequest({ ak, sk, service, region = REGION, action, version, method = 'POST', query = {}, body, host = OPEN_HOST, path = '/', rawResponse = false }) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const payload = method === 'GET' ? '' : JSON.stringify(body ?? {});
  const payloadHash = sha256hex(payload);
  const allQuery = { ...(action ? { Action: action, Version: version } : {}), ...query };
  const canonicalQuery = Object.keys(allQuery).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allQuery[k])}`)
    .join('&');
  const contentType = 'application/json';

  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    method, path, canonicalQuery,
    `content-type:${contentType}`,
    `host:${host}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`,
    '', signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(sk, shortDate), region), service), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(`https://${host}${path}${canonicalQuery ? '?' + canonicalQuery : ''}`, {
    method,
    headers: {
      'Content-Type': contentType,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: method === 'GET' ? undefined : payload,
    signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 60000)),
  });
  if (rawResponse) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------- 推理接入点（Endpoint）自举 + Ark API Key 管理 ----------------
let cachedKey = null; // { key, expiresAt }
let keyErrors = [];
let epList = null; // [{ id, name, model, status }]
let imageEp = null; // { id, model, version }
let imageModelResolved = null;
let imageModelError = null;
let imageAuthOk = null; // null=未知, true=可生成, false=鉴权失败（铸钥 + 直签都不行）

async function arkAdmin(ak, sk, action, body) {
  const { status, json } = await signedOpenApiRequest({
    ak, sk, service: 'ark', action, version: '2024-01-01', body,
  });
  const err = json?.ResponseMetadata?.Error;
  if (status !== 200 || err) {
    throw new Error(`${action} ${status}: ${JSON.stringify(err ?? json).slice(0, 220)}`);
  }
  return json.Result ?? json;
}

async function discoverEndpoints(ak, sk) {
  if (epList) return epList;
  try {
    const res = await arkAdmin(ak, sk, 'ListEndpoints', { PageNumber: 1, PageSize: 100 });
    const items = res?.Items ?? [];
    epList = items
      .filter(it => !it.Status || /running|enable/i.test(String(it.Status)))
      .map(it => ({
        id: it.Id,
        name: it.Name,
        model: it?.ModelReference?.FoundationModel?.Name ?? '',
        version: it?.ModelReference?.FoundationModel?.ModelVersion ?? '',
      }));
  } catch (e) {
    keyErrors.push(e.message);
    epList = [];
  }
  if (!epList.length) {
    // 没有现成接入点 → 自建一个（多模态 flash 优先）
    for (const [name, ver] of [
      ['doubao-seed-1-6-flash', '250828'],
      ['doubao-seed-1-6-flash', '250615'],
      ['doubao-seed-1-6', '250615'],
      ['doubao-1-5-lite-32k', '250115'],
    ]) {
      try {
        const res = await arkAdmin(ak, sk, 'CreateEndpoint', {
          Name: `voxbrush-${name}-${ver}`.slice(0, 50),
          ModelReference: { FoundationModel: { Name: name, ModelVersion: ver } },
        });
        if (res?.Id) {
          epList = [{ id: res.Id, name: `voxbrush-${name}`, model: name, version: ver }];
          console.log(`[volc] 已自建推理接入点 ${res.Id} (${name}@${ver})`);
          break;
        }
      } catch (e) {
        keyErrors.push(e.message);
      }
    }
  }
  console.log(`[volc] 可用接入点: ${epList.map(e => `${e.id}(${e.model})`).join(', ') || '无'}`);
  return epList;
}

async function discoverImageEndpoint(ak, sk) {
  if (imageEp) return imageEp;
  const seedream = (epList ?? []).find(e => /seedream/i.test(e.model));
  if (seedream) {
    imageEp = { id: seedream.id, model: seedream.model, version: seedream.version };
    return imageEp;
  }
  for (const [name, ver] of [
    ['doubao-seedream-4-0', '250415'],
    ['doubao-seedream-4-0', ''],
    ['doubao-seedream-3-0-t2i', '250415'],
    ['doubao-seedream-3-0-t2i', ''],
  ]) {
    try {
      const body = {
        Name: `voxbrush-img-${name}`.slice(0, 50),
        ModelReference: { FoundationModel: { Name: name, ...(ver ? { ModelVersion: ver } : {}) } },
      };
      const res = await arkAdmin(ak, sk, 'CreateEndpoint', body);
      if (res?.Id) {
        imageEp = { id: res.Id, model: name, version: ver };
        epList = [...(epList ?? []), { id: res.Id, name: body.Name, model: name, version: ver }];
        console.log(`[volc] 已自建图像接入点 ${res.Id} (${name}${ver ? '@' + ver : ''})`);
        return imageEp;
      }
    } catch (e) {
      imageModelError = e.message;
      keyErrors.push(e.message);
    }
  }
  return null;
}

async function resolveImageModel() {
  if (imageModelResolved) return imageModelResolved;
  const ak = process.env.VOLC_AK, sk = process.env.VOLC_SK;
  if (!process.env.ARK_API_KEY && (!ak || !sk)) {
    imageModelError = '缺少凭证';
    throw new Error(imageModelError);
  }
  // 持有账号级 ARK_API_KEY 时：直接用配置/候选的图像模型名调用，无需自建推理端点
  if (process.env.ARK_API_KEY && IMAGE_CANDIDATES[0]) {
    imageModelResolved = IMAGE_CANDIDATES[0];
    imageModelError = null;
    return imageModelResolved;
  }
  try {
    if (ak && sk) await discoverEndpoints(ak, sk);
    const ep = ak && sk ? await discoverImageEndpoint(ak, sk) : null;
    if (ep?.id) {
      imageModelResolved = ep.id;
      imageModelError = null;
      return imageModelResolved;
    }
    // 无自建端点时尝试配置的模型名（需账户已开通）
    if (IMAGE_CANDIDATES[0]) {
      imageModelResolved = IMAGE_CANDIDATES[0];
      return imageModelResolved;
    }
    throw new Error(imageModelError ?? '无可用图像接入点');
  } catch (e) {
    imageModelError = e.message;
    throw e;
  }
}

export function imageModelAvailable() {
  // 鉴权探测失败后不再对外宣称可用（L1 提示词据此移除生图能力，红线 #5）
  return (!!imageModelResolved || !!imageEp) && imageAuthOk !== false;
}

export async function initImageModel() {
  try {
    await resolveImageModel();
    console.log(`[volc] 图像模型解析: ${imageModelResolved}，鉴权探测中…`);
    // 启动探测：真实生成一张小图确认鉴权链路（铸钥/直签），让 imageModelAvailable 诚实
    try {
      await arkImagesGenerate({ model: imageModelResolved, prompt: '一个蓝色圆形', size: '1024x1024', response_format: 'url', n: 1 });
      console.log('[volc] 图像生成鉴权 OK，生图能力已启用');
    } catch (e) {
      console.warn(`[volc] 图像生成鉴权失败（生图能力降级）: ${e.message}`);
    }
  } catch (e) {
    console.warn(`[volc] 图像模型不可用（优雅降级）: ${e.message}`);
  }
}

function isAuthErr(status, json) {
  if (status === 401 || status === 403) return true;
  // 仅匹配真正的鉴权错误；不含通用 "invalid"（否则 size/model 参数错误会被误判为鉴权而触发无谓的直签回退）
  return /api key|ak\/sk|unauthor|permission|access denied|not authorized|authentication/i.test(JSON.stringify(json?.error ?? json ?? ''));
}

/**
 * 调 Ark images/generations：铸造的端点级 Bearer key 优先；遇鉴权失败（端点级临时 key
 * 不覆盖基础图像模型时常见）则用 AK/SK SigV4 直签兜底。任一成功置 imageAuthOk=true。
 */
async function arkImagesGenerate(body) {
  const timeout = Number(process.env.ARK_IMAGE_TIMEOUT_MS || 90000);
  let lastErr = null, authFailed = false;
  // 1) 铸造的临时 Bearer key
  try {
    const apiKey = await getArkApiKey();
    const res = await fetch(`https://${ARK_HOST}/api/v3/images/generations`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout),
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json?.data?.[0]?.url) { imageAuthOk = true; return json; }
    lastErr = json?.error?.message || `image ${res.status}`;
    authFailed = isAuthErr(res.status, json);
    if (!authFailed) throw Object.assign(new Error(lastErr), { status: res.status });
  } catch (e) {
    if (e.status && !isAuthErr(e.status, {})) throw e; // 非鉴权错误直接抛
    lastErr = e.message || lastErr;
    authFailed = true;
  }
  // 2) SigV4 直签兜底
  if (authFailed && process.env.VOLC_AK && process.env.VOLC_SK) {
    const res = await signedOpenApiRequest({
      ak: process.env.VOLC_AK, sk: process.env.VOLC_SK,
      service: 'ark', region: 'cn-beijing', host: ARK_HOST,
      path: '/api/v3/images/generations', method: 'POST', body, rawResponse: true,
    });
    const json = await res.json().catch(() => ({}));
    if (res.ok && json?.data?.[0]?.url) { imageAuthOk = true; return json; }
    imageAuthOk = false;
    throw Object.assign(new Error(json?.error?.message || lastErr || `image signed ${res.status}`), { status: res.status });
  }
  imageAuthOk = false;
  throw new Error(lastErr || '图像鉴权失败');
}

export async function generateImage({ prompt, size = '1280x800' }) {
  const model = await resolveImageModel();
  const json = await arkImagesGenerate({ model, prompt: String(prompt).slice(0, 500), size, response_format: 'url', n: 1 });
  const url = json?.data?.[0]?.url;
  if (!url) throw new Error('图像生成返回为空');
  return { url, model };
}

// 风格 → Seedream 提示词（控制"皮肤"，保留构图）
const STYLE_PROMPTS = {
  水彩: '水彩画风格，柔和晕染，纸张纹理，清新淡雅的笔触',
  油画: '厚涂油画风格，明显的笔触肌理，丰富的色彩层次',
  吉卜力: '吉卜力工作室动画风格，宫崎骏，柔和梦幻的色彩，治愈系手绘质感',
  素描: '黑白铅笔素描风格，细腻的线条与明暗关系，纸面质感',
  像素: '像素艺术风格，8-bit 复古游戏画面，分明的色块',
  扁平: '扁平矢量插画风格，简洁的色块，现代设计感',
  写实: '照片级写实风格，真实的光影与材质质感',
  卡通: '卡通插画风格，明快的配色，圆润可爱的造型',
  动漫: '日系动漫风格，鲜明的色彩，赛璐璐上色',
  水墨: '中国水墨画风格，墨色浓淡相宜，留白与意境',
  赛博朋克: '赛博朋克风格，霓虹灯光，未来都市氛围，高对比色调',
  蜡笔: '儿童蜡笔画风格，粗犷的笔触，明亮的色彩',
  梵高: '梵高油画风格，旋转的笔触，强烈的色彩对比',
  印象派: '印象派绘画风格，斑驳的光色，朦胧的笔触',
  极简: '极简主义风格，大量留白，克制的配色',
  复古: '复古怀旧风格，胶片颗粒感，暖黄色调',
  低多边形: '低多边形 low-poly 风格，几何切面，渐变配色',
  蒸汽波: '蒸汽波 vaporwave 风格，粉紫霓虹，复古未来感',
  粘土: '黏土定格动画风格，柔软的体积感与手作质感',
  霓虹: '霓虹发光风格，暗背景上明亮的光线轮廓',
  水晶: '水晶玻璃质感风格，通透折射，高光与反射',
};

/**
 * 风格化渲染（img2img 优先，无图像编辑额度时退化为文生图）。
 * @param image     画布矢量层快照（dataURL/base64 或 https URL），作 img2img 条件图
 * @param style     规范风格名（水彩/吉卜力/…）或自由描述
 * @param sceneDesc 场景文字描述，img2img 不可用时供文生图兜底
 */
export async function renderStyle({ image, style, sceneDesc = '', size = '1280x800' }) {
  const model = await resolveImageModel();
  const styleDesc = STYLE_PROMPTS[style] || `${style}风格`;
  let imgErr = null;

  // 1) 优先 img2img（Seedream 4.0 支持图像输入编辑）：保留构图、只换风格皮肤
  if (image) {
    const prompt = `把这张图改绘成${styleDesc}。严格保持原有的构图、物体位置、数量和整体布局不变，只改变画面的绘画风格与质感。`;
    try {
      const json = await arkImagesGenerate({ model, prompt, image, size, response_format: 'url', n: 1 });
      const url = json?.data?.[0]?.url;
      if (url) return { url, model, mode: 'img2img', style };
    } catch (e) {
      imgErr = e.message; // img2img 不支持/无额度 → 落文生图
    }
  }

  // 2) 退化：文生图（用场景描述 + 风格重绘整幅）
  const t2iPrompt = `${styleDesc}。画面内容：${sceneDesc || '一幅插画'}。完整构图，色彩和谐。`;
  const json2 = await arkImagesGenerate({ model, prompt: t2iPrompt, size, response_format: 'url', n: 1 });
  const url = json2?.data?.[0]?.url;
  if (!url) throw new Error('风格渲染返回为空');
  return { url, model, mode: 't2i', style, fallbackReason: imgErr };
}

export async function getArkApiKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  if (cachedKey && Date.now() < cachedKey.expiresAt - 60 * 60 * 1000) return cachedKey.key;

  const ak = process.env.VOLC_AK, sk = process.env.VOLC_SK;
  if (!ak || !sk) throw new Error('缺少 VOLC_AK/VOLC_SK 或 ARK_API_KEY');

  keyErrors = [];
  const eps = await discoverEndpoints(ak, sk);
  if (!eps.length) throw new Error('无可用推理接入点');
  try {
    const res = await arkAdmin(ak, sk, 'GetApiKey', {
      DurationSeconds: 30 * 86400,
      ResourceType: 'endpoint',
      ResourceIds: eps.map(e => e.id),
    });
    if (res?.ApiKey) {
      cachedKey = { key: res.ApiKey, expiresAt: Date.now() + 30 * 86400 * 1000 };
      return res.ApiKey;
    }
    throw new Error('GetApiKey 返回为空');
  } catch (e) {
    keyErrors.push(e.message);
    throw e;
  }
}

/** 暴露端点列表供模型解析使用 */
export function knownEndpoints() { return epList ?? []; }

// ---------------- Chat Completions ----------------
let authMode = null; // 'api-key' | 'signed'

async function chatOnce({ model, messages, tools, temperature = 0.2, maxTokens = 4096, responseFormat, thinking = 'disabled' }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;
  // seed-1.6 系列默认深度思考，显式关闭以保证交互延迟（不支持该字段的模型自动重试去除）
  if (thinking) body.thinking = { type: thinking };

  let res, json;
  let apiKey = null;
  if (authMode !== 'signed') {
    try { apiKey = await getArkApiKey(); } catch { /* 转直签 */ }
  }
  if (apiKey) {
    res = await fetch(`https://${ARK_HOST}/api/v3/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 60000)),
    });
    json = await res.json().catch(() => ({}));
    if (res.ok) { authMode = 'api-key'; return json; }
    // thinking 字段不被支持时去除重试
    if (res.status === 400 && body.thinking && /thinking/i.test(JSON.stringify(json))) {
      delete body.thinking;
      const r2 = await fetch(`https://${ARK_HOST}/api/v3/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 60000)),
      });
      json = await r2.json().catch(() => ({}));
      if (r2.ok) { authMode = 'api-key'; return json; }
      res = r2;
    }
  } else {
    // 兜底：对 /api/v3 直接 SigV4 签名（service=ark）
    res = await signedOpenApiRequest({
      ak: process.env.VOLC_AK, sk: process.env.VOLC_SK,
      service: 'ark', region: 'cn-beijing',
      host: ARK_HOST, path: '/api/v3/chat/completions',
      method: 'POST', body, rawResponse: true,
    });
    json = await res.json().catch(() => ({}));
    if (res.ok) { authMode = 'signed'; return json; }
  }
  const err = new Error(`Ark ${res.status} [${model}|${apiKey ? 'key' : 'signed'}]: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
  err.status = res.status;
  err.code = json?.error?.code;
  throw err;
}

/** 流式 Chat：逐块回调 content 增量 */
export async function chatStream({ kind = 'text', onDelta, ...args }) {
  const candidates = kind === 'vision' ? VISION_CANDIDATES : TEXT_CANDIDATES;
  const model = await resolveModel(kind, candidates);
  const apiKey = await getArkApiKey();
  const body = {
    model, stream: true,
    messages: args.messages,
    temperature: args.temperature ?? 0.3,
    max_tokens: args.maxTokens ?? 4096,
    thinking: { type: 'disabled' },
  };
  const res = await fetch(`https://${ARK_HOST}/api/v3/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 60000)),
  });
  if (!res.ok || !res.body) {
    const json = await res.json().catch(() => ({}));
    const err = new Error(`Ark stream ${res.status}: ${JSON.stringify(json?.error ?? json).slice(0, 200)}`);
    err.status = res.status;
    throw err;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let full = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop() ?? '';
    for (const line of lines) {
      const m = line.match(/^data:\s*(.*)$/);
      if (!m || m[1] === '[DONE]') continue;
      try {
        const delta = JSON.parse(m[1])?.choices?.[0]?.delta?.content ?? '';
        if (delta) { full += delta; onDelta?.(delta, full); }
      } catch { /* 跳过非 JSON 行 */ }
    }
  }
  return { content: full, model };
}

const resolved = { text: null, vision: null };

async function resolveModel(kind, candidates) {
  if (resolved[kind]) return resolved[kind];
  // 接入点 ID 优先（铸造的临时 Key 仅对接入点生效）
  const eps = knownEndpoints();
  const epIds = (kind === 'vision'
    ? [...eps.filter(e => /seed-1-6|vision|omni/.test(e.model)), ...eps]
    : eps
  ).map(e => e.id);
  const all = [...new Set([...epIds, ...candidates])];
  let lastErr = null;
  for (const m of all) {
    try {
      await chatOnce({ model: m, messages: [{ role: 'user', content: 'ping，回复 pong' }], maxTokens: 8 });
      resolved[kind] = m;
      console.log(`[volc] ${kind} 模型探测成功: ${m}`);
      return m;
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr ?? new Error('无可用模型');
}

export async function chat({ kind = 'text', ...args }) {
  const candidates = kind === 'vision' ? VISION_CANDIDATES : TEXT_CANDIDATES;
  const model = await resolveModel(kind, candidates);
  try {
    return await chatOnce({ model, ...args });
  } catch (e) {
    if (e.status === 404) { resolved[kind] = null; } // 模型下线，下次重新探测
    throw e;
  }
}

export async function arkStatus() {
  const out = { auth: 'unknown', authMode, textModel: resolved.text, visionModel: resolved.vision, imageModel: null };
  try {
    try {
      await getArkApiKey();
      out.auth = process.env.ARK_API_KEY ? 'env-api-key' : 'ak/sk minted';
    } catch {
      out.auth = 'fallback-signed';
    }
    out.keyErrors = keyErrors;
    out.endpoints = knownEndpoints();
    try { out.textModel = await resolveModel('text', TEXT_CANDIDATES); } catch (e) { out.modelError = e.message; }
    try { out.visionModel = await resolveModel('vision', VISION_CANDIDATES); } catch { /* noop */ }
    try {
      out.imageModel = await resolveImageModel();
      out.imageAvailable = imageModelAvailable();
      out.imageAuthOk = imageAuthOk;
    } catch (e) {
      out.imageAvailable = false;
      out.imageModelError = imageModelError ?? e.message;
    }
    out.authMode = authMode;
  } catch (e) {
    out.auth = 'failed';
    out.authError = e.message;
  }
  return out;
}

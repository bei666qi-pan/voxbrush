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
    signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 30000)),
  });
  if (rawResponse) return res;
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------- 推理接入点（Endpoint）自举 + Ark API Key 管理 ----------------
let cachedKey = null; // { key, expiresAt }
let keyErrors = [];
let epList = null; // [{ id, name, model, status }]

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

async function chatOnce({ model, messages, tools, temperature = 0.2, maxTokens = 4096, responseFormat }) {
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;

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
      signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 30000)),
    });
    json = await res.json().catch(() => ({}));
    if (res.ok) { authMode = 'api-key'; return json; }
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
  const out = { auth: 'unknown', authMode, textModel: resolved.text, visionModel: resolved.vision };
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
    try { out.visionModel = await resolveModel('vision', VISION_CANDIDATES); } catch { /* 已在 modelError 体现 */ }
    out.authMode = authMode;
  } catch (e) {
    out.auth = 'failed';
    out.authError = e.message;
  }
  return out;
}

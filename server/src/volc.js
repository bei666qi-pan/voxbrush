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

/** 火山引擎 OpenAPI SigV4 签名请求（通用：支持 GET/POST + 自定义 service/region/query） */
export async function signedOpenApiRequest({ ak, sk, service, region = REGION, action, version, method = 'POST', query = {}, body }) {
  const now = new Date();
  const xDate = now.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, ''); // YYYYMMDDTHHMMSSZ
  const shortDate = xDate.slice(0, 8);
  const payload = method === 'GET' ? '' : JSON.stringify(body ?? {});
  const payloadHash = sha256hex(payload);
  const allQuery = { Action: action, Version: version, ...query };
  const canonicalQuery = Object.keys(allQuery).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(allQuery[k])}`)
    .join('&');
  const contentType = 'application/json';

  const signedHeaders = 'content-type;host;x-content-sha256;x-date';
  const canonicalRequest = [
    method, '/', canonicalQuery,
    `content-type:${contentType}`,
    `host:${OPEN_HOST}`,
    `x-content-sha256:${payloadHash}`,
    `x-date:${xDate}`,
    '', signedHeaders, payloadHash,
  ].join('\n');

  const scope = `${shortDate}/${region}/${service}/request`;
  const stringToSign = ['HMAC-SHA256', xDate, scope, sha256hex(canonicalRequest)].join('\n');
  const kSigning = hmac(hmac(hmac(hmac(sk, shortDate), region), service), 'request');
  const signature = crypto.createHmac('sha256', kSigning).update(stringToSign, 'utf8').digest('hex');

  const res = await fetch(`https://${OPEN_HOST}/?${canonicalQuery}`, {
    method,
    headers: {
      'Content-Type': contentType,
      'X-Date': xDate,
      'X-Content-Sha256': payloadHash,
      Authorization: `HMAC-SHA256 Credential=${ak}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
    body: method === 'GET' ? undefined : payload,
    signal: AbortSignal.timeout(10000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// ---------------- Ark API Key 管理 ----------------
let cachedKey = null; // { key, expiresAt }
let lastKeyError = null;

export async function getArkApiKey() {
  if (process.env.ARK_API_KEY) return process.env.ARK_API_KEY;
  if (cachedKey && Date.now() < cachedKey.expiresAt - 60 * 60 * 1000) return cachedKey.key;

  const ak = process.env.VOLC_AK, sk = process.env.VOLC_SK;
  if (!ak || !sk) throw new Error('缺少 VOLC_AK/VOLC_SK 或 ARK_API_KEY');

  const allModels = [...new Set([...TEXT_CANDIDATES, ...VISION_CANDIDATES])];
  // 不同账号/版本对 ResourceType 的要求不同，逐一尝试
  const attempts = [
    { DurationSeconds: 30 * 86400 },
    { DurationSeconds: 30 * 86400, ResourceType: 'endpoint', ResourceIds: allModels },
    { DurationSeconds: 7 * 86400, ResourceType: 'model', ResourceIds: allModels },
  ];
  for (const body of attempts) {
    try {
      const { status, json } = await signedOpenApiRequest({
        ak, sk, service: 'ark', action: 'GetApiKey', version: '2024-01-01', body,
      });
      const key = json?.Result?.ApiKey;
      if (status === 200 && key) {
        const ttl = (body.DurationSeconds ?? 86400) * 1000;
        cachedKey = { key, expiresAt: Date.now() + ttl };
        lastKeyError = null;
        return key;
      }
      lastKeyError = `GetApiKey ${status}: ${JSON.stringify(json?.ResponseMetadata?.Error ?? json).slice(0, 300)}`;
    } catch (e) {
      lastKeyError = `GetApiKey 异常: ${e.message}`;
    }
  }
  throw new Error(lastKeyError ?? 'GetApiKey 失败');
}

// ---------------- Chat Completions ----------------
async function chatOnce({ model, messages, tools, temperature = 0.2, maxTokens = 4096, responseFormat }) {
  const apiKey = await getArkApiKey();
  const body = { model, messages, temperature, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  if (responseFormat) body.response_format = responseFormat;
  const res = await fetch(`https://${ARK_HOST}/api/v3/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Number(process.env.ARK_TIMEOUT_MS || 30000)),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(`Ark ${res.status} [${model}]: ${JSON.stringify(json?.error ?? json).slice(0, 300)}`);
    err.status = res.status;
    err.code = json?.error?.code;
    throw err;
  }
  return json;
}

const resolved = { text: null, vision: null };

async function resolveModel(kind, candidates) {
  if (resolved[kind]) return resolved[kind];
  let lastErr = null;
  for (const m of candidates) {
    try {
      await chatOnce({ model: m, messages: [{ role: 'user', content: 'ping，回复 pong' }], maxTokens: 8 });
      resolved[kind] = m;
      console.log(`[volc] ${kind} 模型探测成功: ${m}`);
      return m;
    } catch (e) {
      lastErr = e;
      // 鉴权类错误无需继续换模型
      if (e.status === 401 || e.status === 403) throw e;
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
  const out = { auth: 'unknown', textModel: resolved.text, visionModel: resolved.vision, lastKeyError };
  try {
    await getArkApiKey();
    out.auth = process.env.ARK_API_KEY ? 'env-api-key' : 'ak/sk minted';
    try { out.textModel = await resolveModel('text', TEXT_CANDIDATES); } catch (e) { out.modelError = e.message; }
    try { out.visionModel = await resolveModel('vision', VISION_CANDIDATES); } catch { /* 已在 modelError 体现 */ }
  } catch (e) {
    out.auth = 'failed';
    out.authError = e.message;
  }
  return out;
}

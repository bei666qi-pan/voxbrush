/**
 * DNS 自举：启动时确保 ENSURE_DNS 域名的 A 记录指向本服务器（火山云解析 TrafficRoute）。
 * 环境变量：ENSURE_DNS=qiniu.versecraft.cn  DNS_IP=14.103.217.111
 * 失败不影响主服务，状态在 /api/health 暴露。
 */
import { signedOpenApiRequest } from './volc.js';

const SERVICE = 'DNS';
const VERSION = '2018-08-01';
const REGIONS = ['cn-north-1', 'cn-beijing'];

let state = { status: 'disabled' };
export const dnsStatus = () => state;

async function call(ak, sk, region, action, { method = 'GET', query = {}, body } = {}) {
  const { status, json } = await signedOpenApiRequest({
    ak, sk, service: SERVICE, region, action, version: VERSION, method, query, body,
  });
  const err = json?.ResponseMetadata?.Error;
  if (status !== 200 || err) throw new Error(`${action} ${status}: ${JSON.stringify(err ?? json).slice(0, 200)}`);
  return json.Result ?? json;
}

export async function ensureDns() {
  const fqdn = process.env.ENSURE_DNS;
  const ip = process.env.DNS_IP;
  const ak = process.env.VOLC_AK, sk = process.env.VOLC_SK;
  if (!fqdn || !ip || !ak || !sk) return;

  state = { status: 'pending', fqdn, ip };
  const parts = fqdn.split('.');
  const zone = parts.slice(-2).join('.');
  const host = parts.slice(0, -2).join('.') || '@';

  let lastErr = null;
  for (const region of REGIONS) {
    try {
      const zones = await call(ak, sk, region, 'ListZones', { query: { PageSize: '100' } });
      const z = (zones.Zones ?? []).find(x => x.ZoneName === zone);
      if (!z) throw new Error(`zone ${zone} 不在此账号`);
      const recs = await call(ak, sk, region, 'ListRecords', { query: { ZID: String(z.ZID), Host: host, PageSize: '100' } });
      const existing = (recs.Records ?? []).find(r => r.Host === host && r.Type === 'A');
      if (existing && existing.Value === ip) {
        state = { status: 'ok', fqdn, ip, action: 'noop' };
        console.log(`[dns] ${fqdn} → ${ip} 已存在`);
        return;
      }
      if (existing) {
        await call(ak, sk, region, 'UpdateRecord', {
          method: 'POST',
          body: { RecordID: existing.RecordID, Host: host, Type: 'A', Value: ip, TTL: 600 },
        });
        state = { status: 'ok', fqdn, ip, action: 'updated' };
      } else {
        await call(ak, sk, region, 'CreateRecord', {
          method: 'POST',
          body: { ZID: z.ZID, Host: host, Type: 'A', Value: ip, TTL: 600 },
        });
        state = { status: 'ok', fqdn, ip, action: 'created' };
      }
      console.log(`[dns] ${fqdn} → ${ip} ${state.action}`);
      return;
    } catch (e) {
      lastErr = e;
    }
  }
  state = { status: 'failed', fqdn, ip, error: lastErr?.message };
  console.error('[dns] 自举失败:', lastErr?.message);
}

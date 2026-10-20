/**
 * 带鉴权探针：用 $DSH_HOME/.credentials.yaml 里的浏览器会话密钥自签 cookie，
 * 直接请求宿主 HTTP 端点，用来验证插件路由是否真的挂上、返回什么形状。
 *
 * 密钥只在本进程里用，从不打印。
 *
 * 用法：
 *   node tools/probe-http.mjs GET  /api/v1/child-model/state
 *   node tools/probe-http.mjs POST /api/v1/child-model/rules '{"enabled":true}'
 */
import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AUTHORITY = process.env.PROBE_AUTHORITY ?? '127.0.0.1:3080';

function dshHome() {
  const override = (process.env.DSH_HOME ?? '').trim();
  return override === '' ? join(homedir(), '.dsh') : override;
}

/** 从 credentials.yaml 里抠出 browser-session 的 secret（YAML 结构简单，按缩进取）。 */
function browserSecret() {
  const text = readFileSync(join(dshHome(), '.credentials.yaml'), 'utf8');
  const lines = text.split(/\r?\n/);
  let inRecord = false;
  let recordIndent = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === 'client-connection/browser-session:') {
      inRecord = true;
      recordIndent = line.length - line.trimStart().length;
      continue;
    }
    if (!inRecord) continue;
    const indent = line.length - line.trimStart().length;
    if (trimmed !== '' && indent <= recordIndent) {
      inRecord = false;
      continue;
    }
    const match = /^secret:\s*(\S+)\s*$/.exec(trimmed);
    if (match) return match[1];
  }
  throw new Error('找不到 client-connection/browser-session 的 secret');
}

function base64url(buffer) {
  return Buffer.from(buffer).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function cookieHeader() {
  // 存的是 base64url 编码的 32 字节随机串；HMAC 的 key 是**解码后的字节**，
  // 不是 yaml 里那串文本（canonicalSecret 会先 decodeBase64Url）。
  const secret = Buffer.from(browserSecret().replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const now = Date.now();
  const payload = {
    version: 1,
    authority: AUTHORITY,
    issuedAt: now,
    expiresAt: now + 3600_000,
  };
  // 与 dsh-client-connection 的 encodeCookie 逐字一致：
  // body 是「JSON → base64url」，签名对象是**这个 base64url 串**，不是原始 JSON。
  const body = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  const signature = createHmac('sha256', secret).update(body).digest();
  const value = `v${payload.version}.${body}.${base64url(signature)}`;
  const name = `dsh-auth-${base64url(createHash('sha256').update(AUTHORITY).digest())}`;
  return `${name}=${value}`;
}

const [, , method = 'GET', path = '/', payload] = process.argv;
// 有些端点会等一次真委派（spawn 子智能体 / 队友），给足时间并允许用
// PROBE_TIMEOUT_MS 覆盖；默认 60s 而不是 undici 默认的 300s，超时就明确报。
const timeoutMs = Number(process.env.PROBE_TIMEOUT_MS ?? 60000);
const abort = AbortSignal.timeout(timeoutMs);
const response = await fetch(`http://${AUTHORITY}${path}`, {
  method,
  headers: {
    cookie: cookieHeader(),
    ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
  },
  ...(payload === undefined ? {} : { body: payload }),
  signal: abort,
});
const text = await response.text();
console.log(`${method} ${path} => ${response.status}`);
try {
  console.log(JSON.stringify(JSON.parse(text), null, 2));
} catch {
  console.log(text.slice(0, 800));
}

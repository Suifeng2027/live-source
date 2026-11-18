// 管理端鉴权：仅接受 Cloudflare Access 在边缘注入的 Cf-Access-Jwt-Assertion。
// 必须完成真实 RS256 验签与 Claims 校验后，才会产出操作人身份；
// 任何失败一律 fail-closed：凭证问题返回 401，认证配置或 JWKS 不可用返回 503。
// 不接受 Bearer / Cookie / Cf-Access-Authenticated-User-Email，也不存在放行分支。

import { errorResponse } from "./response.js";

const JWKS_TTL_MS = 3600 * 1000;        // JWKS 缓存有效期
const UNKNOWN_KID_COOLDOWN_MS = 60 * 1000; // 未知 kid 的短时负缓存，避免被用于放大请求
const JWKS_TIMEOUT_MS = 5000;
const NBF_LEEWAY_SECONDS = 60;          // nbf 允许的时钟容差（仅 nbf）
const TEAM_DOMAIN_RE = /^https:\/\/[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.cloudflareaccess\.com$/i;

let jwksCache = null;      // { teamDomain, fetchedAt, keys: Map<kid, jwk> }
let jwksInFlight = null;   // Promise<Map>，用于请求合并
let jwksInFlightTeam = "";
const unknownKidAt = new Map(); // kid -> 最近一次未命中的时间戳

/**
 * 校验管理端请求。
 * @returns {Promise<Response|null>} 通过返回 null（并写入 context.data.admin），失败返回错误响应
 */
export async function checkAdminAuth(context) {
  const config = readConfig(context.env);
  if (!config.ok) {
    return authUnavailable(config.reason);
  }

  // 1) 只读 Cf-Access-Jwt-Assertion
  const token = context.request.headers.get("Cf-Access-Jwt-Assertion");
  if (!token) {
    return unauthorized("missing_token");
  }

  // 2) 必须是三段式 JWT
  const parts = token.split(".");
  if (parts.length !== 3) {
    return unauthorized("malformed_token");
  }
  const headerSeg = parts[0];
  const payloadSeg = parts[1];
  const signatureSeg = parts[2];

  // 3) 严格 Base64URL 解码（任何非法字符/非法长度都拒绝）
  const headerBytes = decodeBase64Url(headerSeg);
  const payloadBytes = decodeBase64Url(payloadSeg);
  const signatureBytes = decodeBase64Url(signatureSeg);
  if (!headerBytes || !payloadBytes || !signatureBytes) {
    return unauthorized("invalid_encoding");
  }

  // 4) 解析 Header，只接受 RS256 且 kid 为非空字符串
  let header;
  try {
    header = JSON.parse(new TextDecoder().decode(headerBytes));
  } catch (_e) {
    return unauthorized("invalid_header");
  }
  if (!header || typeof header !== "object" || header.alg !== "RS256") {
    return unauthorized("unsupported_alg");
  }
  if (typeof header.kid !== "string" || header.kid.trim() === "") {
    return unauthorized("missing_kid");
  }
  const kid = header.kid;

  // 5) 取 JWKS 并按 kid 精确匹配（不得默认取第一把）
  const first = await getJwks(config.teamDomain);
  if (!first.ok) {
    return authUnavailable("jwks_fetch_failed");
  }
  let jwk = first.keys.get(kid);
  if (!jwk) {
    const lastMiss = unknownKidAt.get(kid);
    if (lastMiss && Date.now() - lastMiss < UNKNOWN_KID_COOLDOWN_MS) {
      return unauthorized("unknown_kid");
    }
    // 缓存未命中时强制重取一次，仍无则拒绝
    const refreshed = await getJwks(config.teamDomain, true);
    if (!refreshed.ok) {
      return authUnavailable("jwks_fetch_failed");
    }
    jwk = refreshed.keys.get(kid);
    if (!jwk) {
      unknownKidAt.set(kid, Date.now());
      return unauthorized("unknown_kid");
    }
  }

  // 6) 导入公钥并用 crypto.subtle 验证原始签名
  let verifyKey;
  try {
    verifyKey = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"]
    );
  } catch (_e) {
    return unauthorized("invalid_public_key");
  }

  let signatureValid = false;
  try {
    // 验签对象必须是原始 "header.payload" 字节，不得重新序列化 JSON
    const signingInput = new TextEncoder().encode(headerSeg + "." + payloadSeg);
    signatureValid = await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      verifyKey,
      signatureBytes,
      signingInput
    );
  } catch (_e) {
    return unauthorized("signature_verify_failed");
  }
  if (!signatureValid) {
    return unauthorized("signature_verify_failed");
  }

  // 7) 验签通过后才解析并校验 Claims
  let payload;
  try {
    payload = JSON.parse(new TextDecoder().decode(payloadBytes));
  } catch (_e) {
    return unauthorized("invalid_payload");
  }
  if (!payload || typeof payload !== "object") {
    return unauthorized("invalid_payload");
  }

  const nowSec = Math.floor(Date.now() / 1000);

  if (payload.iss !== config.issuer) {
    return unauthorized("invalid_issuer");
  }

  const audClaim = payload.aud;
  const audienceOk =
    typeof audClaim === "string"
      ? audClaim === config.aud
      : Array.isArray(audClaim) && audClaim.indexOf(config.aud) !== -1;
  if (!audienceOk) {
    return unauthorized("invalid_audience");
  }

  if (typeof payload.exp !== "number" || !Number.isFinite(payload.exp) || payload.exp <= nowSec) {
    return unauthorized("invalid_exp");
  }

  if (payload.nbf !== undefined) {
    if (
      typeof payload.nbf !== "number" ||
      !Number.isFinite(payload.nbf) ||
      payload.nbf > nowSec + NBF_LEEWAY_SECONDS
    ) {
      return unauthorized("invalid_nbf");
    }
  }

  // 8) 仅在全部校验通过后读取 email，且不接受任何替代身份
  const email = typeof payload.email === "string" ? payload.email.trim() : "";
  if (email === "" || email.indexOf("@") === -1) {
    return unauthorized("invalid_email");
  }

  if (!context.data || typeof context.data !== "object") {
    context.data = {};
  }
  context.data.admin = email;
  return null;
}

/** 读取并严格校验认证配置；缺失或格式非法时不放行 */
function readConfig(env) {
  const rawTeam =
    env && typeof env.ACCESS_TEAM_DOMAIN === "string"
      ? env.ACCESS_TEAM_DOMAIN.trim().replace(/\/+$/, "")
      : "";
  if (rawTeam === "" || !TEAM_DOMAIN_RE.test(rawTeam)) {
    return { ok: false, reason: "invalid_team_domain" };
  }

  const aud = env && typeof env.ACCESS_AUD === "string" ? env.ACCESS_AUD.trim() : "";
  if (aud === "") {
    return { ok: false, reason: "invalid_aud" };
  }

  const teamDomain = rawTeam.toLowerCase();
  return { ok: true, teamDomain: teamDomain, issuer: teamDomain, aud: aud };
}

/** 获取 JWKS（模块级缓存 + 请求合并） */
async function getJwks(teamDomain, force) {
  const now = Date.now();
  if (
    !force &&
    jwksCache &&
    jwksCache.teamDomain === teamDomain &&
    now - jwksCache.fetchedAt < JWKS_TTL_MS
  ) {
    return { ok: true, keys: jwksCache.keys };
  }

  if (jwksInFlight && jwksInFlightTeam === teamDomain) {
    try {
      const keys = await jwksInFlight;
      return { ok: true, keys: keys };
    } catch (_e) {
      return { ok: false };
    }
  }

  const task = fetchJwks(teamDomain);
  jwksInFlight = task;
  jwksInFlightTeam = teamDomain;
  try {
    const keys = await task;
    jwksCache = { teamDomain: teamDomain, fetchedAt: Date.now(), keys: keys };
    return { ok: true, keys: keys };
  } catch (_e) {
    return { ok: false };
  } finally {
    if (jwksInFlight === task) {
      jwksInFlight = null;
      jwksInFlightTeam = "";
    }
  }
}

/** 拉取并解析 JWKS；HTTP 失败、超时、非 JSON、结构无效均抛错 */
async function fetchJwks(teamDomain) {
  const controller = new AbortController();
  const timer = setTimeout(function () {
    controller.abort();
  }, JWKS_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(teamDomain + "/cdn-cgi/access/certs", {
      method: "GET",
      headers: { accept: "application/json" },
      signal: controller.signal
    });
  } finally {
    clearTimeout(timer);
  }

  if (!res || !res.ok) {
    throw new Error("jwks_http_error");
  }

  const data = await res.json();
  if (!data || !Array.isArray(data.keys)) {
    throw new Error("jwks_invalid_structure");
  }

  const keys = new Map();
  for (let i = 0; i < data.keys.length; i++) {
    const key = data.keys[i];
    if (!key || key.kty !== "RSA") continue;
    if (typeof key.kid !== "string" || key.kid === "") continue;
    if (typeof key.n !== "string" || typeof key.e !== "string") continue;
    if (key.alg && key.alg !== "RS256") continue;
    keys.set(key.kid, { kty: "RSA", n: key.n, e: key.e, alg: "RS256", ext: true });
  }
  if (keys.size === 0) {
    throw new Error("jwks_no_usable_key");
  }
  return keys;
}

/** 严格 Base64URL 解码：仅允许 A-Z a-z 0-9 - _，长度不得为 4n+1 */
function decodeBase64Url(segment) {
  if (typeof segment !== "string" || segment === "") return null;
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return null;
  if (segment.length % 4 === 1) return null;
  const base64 =
    segment.replace(/-/g, "+").replace(/_/g, "/") +
    "=".repeat((4 - (segment.length % 4)) % 4);
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  } catch (_e) {
    return null;
  }
}

function unauthorized(reason) {
  console.error("[admin/auth] rejected: " + reason);
  return errorResponse(401, "unauthorized", 401);
}

function authUnavailable(reason) {
  console.error("[admin/auth] unavailable: " + reason);
  return errorResponse(503, "auth_unavailable", 503);
}

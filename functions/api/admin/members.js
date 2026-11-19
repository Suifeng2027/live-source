// GET /api/admin/members  会员列表（搜索、筛选、分页）
// POST /api/admin/members 新增会员

import { jsonResponse, errorResponse, methodNotAllowed } from "../../_lib/response.js";
import { checkAdminAuth } from "../../_lib/auth.js";
import { writeOpLog, getClientIp } from "../../_lib/log.js";

const DAY = 86400;
const PHONE_RE = /^1[3-9][0-9]{9}$/;
const MAX_DAYS = 3650;
const MAX_PAGE_SIZE = 100;

// 状态计算（必须与 check.js 授权规则一致）
// vip=1 且 start>0 且 end>0 且 serverTime>=start 且 serverTime<=end 才算有效授权
function computeStatus(vip, startTime, endTime, serverTime) {
  if (Number(vip) !== 1) return "disabled";
  if (startTime <= 0 || endTime <= 0) return "disabled";
  if (startTime > serverTime) return "not_started";
  if (endTime < serverTime) return "expired";
  const daysLeft = Math.ceil((endTime - serverTime) / DAY);
  if (daysLeft <= 30) return "expiring";
  return "active";
}

function daysLeftOf(endTime, serverTime) {
  return Math.ceil((endTime - serverTime) / DAY);
}

function mapRow(row, serverTime) {
  const startTime = Number(row.start_time) || 0;
  const endTime = Number(row.end_time) || 0;
  const vip = Number(row.vip);
  return {
    id: row.id,
    phone: row.phone,
    deviceId: row.device_id,
    vip,
    startTime,
    endTime,
    lastSeen: Number(row.last_seen) || 0,
    createdAt: Number(row.created_at) || 0,
    updatedAt: Number(row.updated_at) || 0,
    status: computeStatus(vip, startTime, endTime, serverTime),
    daysLeft: daysLeftOf(endTime, serverTime)
  };
}

// 判断是否为唯一约束冲突
function isUniqueConstraintError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /UNIQUE constraint failed/i.test(msg) ||
    (err && err.cause && /UNIQUE/i.test(String(err.cause.message || "")));
}

// ===================== GET 列表 =====================
async function handleGet(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;

  const serverTime = Math.floor(Date.now() / 1000);
  const db = context.env.MEMBERS_DB;
  if (!db) return errorResponse(500, "MEMBERS_DB not configured", 500);

  const url = new URL(context.request.url);
  const phone = (url.searchParams.get("phone") || "").trim();
  const deviceId = (url.searchParams.get("deviceId") || "").trim();
  const status = (url.searchParams.get("status") || "").trim();
  const expire = (url.searchParams.get("expire") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  let pageSize = parseInt(url.searchParams.get("pageSize") || "10", 10) || 10;
  if (pageSize < 1) pageSize = 10;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  // 构建动态 WHERE
  const conditions = [];
  const params = [];

  if (phone) {
    conditions.push("phone LIKE ?");
    params.push("%" + phone + "%");
  }
  if (deviceId) {
    conditions.push("LOWER(device_id) LIKE ?");
    params.push("%" + deviceId.toLowerCase() + "%");
  }

  // expire 筛选（基于 end_time 与 serverTime 的差值）
  if (expire) {
    if (expire === "expired") {
      conditions.push("end_time < ?");
      params.push(serverTime);
    } else {
      const days = parseInt(expire, 10);
      if (!isNaN(days) && days > 0) {
        conditions.push("end_time >= ?");
        params.push(serverTime);
        conditions.push("(end_time - ?) <= ?");
        params.push(serverTime, days * DAY);
      }
    }
  }

  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  // 用 CTE 计算 status，便于 status 筛选与 total 统计使用同一过滤条件
  const baseSql = `
    WITH m AS (
      SELECT *,
        CASE
          WHEN vip != 1 THEN 'disabled'
          WHEN start_time <= 0 OR end_time <= 0 THEN 'disabled'
          WHEN start_time > ? THEN 'not_started'
          WHEN end_time < ? THEN 'expired'
          WHEN (end_time - ?) <= 30 * 86400 THEN 'expiring'
          ELSE 'active'
        END AS status
      FROM members
      ${where}
    )
  `;

  const statusParams = [serverTime, serverTime, serverTime];
  const cteParams = statusParams.concat(params);

  let finalWhere = "";
  let finalParams = cteParams.slice();
  if (status) {
    finalWhere = "WHERE status = ?";
    finalParams.push(status);
  }

  try {
    // total
    const countRow = await db
      .prepare(baseSql + `SELECT COUNT(*) AS c FROM m ${finalWhere}`)
      .bind(...finalParams)
      .first();
    const total = Number(countRow && countRow.c) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    // list
    const rows = await db
      .prepare(baseSql + `SELECT * FROM m ${finalWhere} ORDER BY id DESC LIMIT ? OFFSET ?`)
      .bind(...finalParams, pageSize, offset)
      .all();

    const list = ((rows && rows.results) || []).map(r => mapRow(r, serverTime));

    return jsonResponse({
      code: 0,
      data: { list, total, page, pageSize, totalPages },
      serverTime
    });
  } catch (err) {
    console.error("[admin/members] list error:", err);
    return errorResponse(500, "members_list_failed", 500);
  }
}

// ===================== POST 新增 =====================
async function handlePost(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;

  const serverTime = Math.floor(Date.now() / 1000);
  const db = context.env.MEMBERS_DB;
  if (!db) return errorResponse(500, "MEMBERS_DB not configured", 500);

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return errorResponse(400, "invalid_json", 400);
  }

  const phone = String(body && body.phone ? body.phone : "").trim();
  const deviceId = String(body && body.deviceId ? body.deviceId : "").trim();
  const days = body && body.days;

  // 校验
  if (!PHONE_RE.test(phone)) {
    return errorResponse(400, "invalid_phone", 400);
  }
  if (!deviceId) {
    return errorResponse(400, "device_id_required", 400);
  }
  if (deviceId.length > 128) {
    return errorResponse(400, "device_id_too_long", 400);
  }
  if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
    return errorResponse(400, "invalid_days", 400);
  }

  const startTime = serverTime;
  const endTime = serverTime + days * DAY;

  try {
    // 事前查重（减少冲突概率，但仍以 DB 约束为准）
    const phoneRow = await db
      .prepare("SELECT id FROM members WHERE phone = ? LIMIT 1")
      .bind(phone)
      .first();
    if (phoneRow) {
      return errorResponse(409, "phone_exists", 409);
    }
    const deviceRow = await db
      .prepare("SELECT id FROM members WHERE device_id = ? LIMIT 1")
      .bind(deviceId)
      .first();
    if (deviceRow) {
      return errorResponse(409, "device_id_exists", 409);
    }

    // 新建会员 last_seen = 0（设备尚未访问）
    const result = await db
      .prepare(`
        INSERT INTO members (phone, device_id, vip, start_time, end_time, created_at, updated_at, last_seen)
        VALUES (?, ?, 1, ?, ?, ?, ?, 0)
      `)
      .bind(phone, deviceId, startTime, endTime, serverTime, serverTime)
      .run();

    const id = result && result.meta ? result.meta.last_row_id : null;

    // 回读数据库记录，保证 createdAt/updatedAt 等为库内真实值
    const created = await db
      .prepare(
        "SELECT id, phone, device_id, vip, start_time, end_time, last_seen, created_at, updated_at FROM members WHERE id = ? LIMIT 1"
      )
      .bind(id)
      .first();

    await writeOpLog(db, {
      action: "create",
      target: phone,
      detail: "+" + days + "天",
      result: "success",
      admin: context.data.admin,
      ip: getClientIp(context.request)
    });

    // 回读失败不允许返回成功，避免用本地变量伪造库内字段
    if (!created || created.id == null) {
      return errorResponse(500, "member_readback_failed", 500);
    }

    return jsonResponse({
      code: 0,
      msg: "created",
      data: mapRow(created, serverTime),
      serverTime
    }, 201);
  } catch (err) {
    // 捕获并发唯一约束冲突
    if (isUniqueConstraintError(err)) {
      const msg = /phone/i.test(String(err.message || err)) ? "phone_exists" : "device_id_exists";
      return errorResponse(409, msg, 409);
    }
    console.error("[admin/members] create error:", err);
    return errorResponse(500, "member_create_failed", 500);
  }
}

export async function onRequestGet(context) {
  return handleGet(context);
}

export async function onRequestPost(context) {
  return handlePost(context);
}

export async function onRequest(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;
  return methodNotAllowed("GET, POST");
}

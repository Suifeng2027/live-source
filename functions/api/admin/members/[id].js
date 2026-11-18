// GET   /api/admin/members/:id  会员详情
// PATCH /api/admin/members/:id  修改会员（续费/停用/恢复/改手机号/改设备ID）

import { jsonResponse, errorResponse, methodNotAllowed } from "../../../_lib/response.js";
import { checkAdminAuth } from "../../../_lib/auth.js";
import { writeOpLog, getClientIp } from "../../../_lib/log.js";

const DAY = 86400;
const PHONE_RE = /^1[3-9][0-9]{9}$/;
const MAX_DAYS = 3650;

function computeStatus(vip, startTime, endTime, serverTime) {
  if (Number(vip) !== 1) return "disabled";
  if (startTime <= 0 || endTime <= 0) return "disabled";
  if (startTime > serverTime) return "not_started";
  if (endTime < serverTime) return "expired";
  const daysLeft = Math.ceil((endTime - serverTime) / DAY);
  if (daysLeft <= 30) return "expiring";
  return "active";
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
    daysLeft: Math.ceil((endTime - serverTime) / DAY)
  };
}

function isUniqueConstraintError(err) {
  const msg = String(err && err.message ? err.message : err);
  return /UNIQUE constraint failed/i.test(msg) ||
    (err && err.cause && /UNIQUE/i.test(String(err.cause.message || "")));
}

// ===================== GET 详情 =====================
async function handleGet(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;

  const serverTime = Math.floor(Date.now() / 1000);
  const db = context.env.MEMBERS_DB;
  if (!db) return errorResponse(500, "MEMBERS_DB not configured", 500);

  const id = parseInt(context.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return errorResponse(400, "invalid_id", 400);
  }

  try {
    const row = await db
      .prepare(`
        SELECT id, phone, device_id, vip, start_time, end_time, last_seen, created_at, updated_at
        FROM members WHERE id = ? LIMIT 1
      `)
      .bind(id)
      .first();

    if (!row) {
      return errorResponse(404, "member_not_found", 404);
    }

    return jsonResponse({ code: 0, data: mapRow(row, serverTime), serverTime });
  } catch (err) {
    console.error("[admin/members/:id] detail error:", err);
    return errorResponse(500, "member_detail_failed", 500);
  }
}

// ===================== PATCH 修改 =====================
async function handlePatch(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;

  const serverTime = Math.floor(Date.now() / 1000);
  const db = context.env.MEMBERS_DB;
  if (!db) return errorResponse(500, "MEMBERS_DB not configured", 500);

  const id = parseInt(context.params.id, 10);
  if (isNaN(id) || id <= 0) {
    return errorResponse(400, "invalid_id", 400);
  }

  let body;
  try {
    body = await context.request.json();
  } catch (e) {
    return errorResponse(400, "invalid_json", 400);
  }

  const action = String(body && body.action ? body.action : "").trim();
  if (!action) {
    return errorResponse(400, "action_required", 400);
  }

  // 先查出会员
  let member;
  try {
    member = await db
      .prepare(`
        SELECT id, phone, device_id, vip, start_time, end_time, last_seen, created_at
        FROM members WHERE id = ? LIMIT 1
      `)
      .bind(id)
      .first();
  } catch (err) {
    console.error("[admin/members/:id] fetch error:", err);
    return errorResponse(500, "member_fetch_failed", 500);
  }

  if (!member) {
    return errorResponse(404, "member_not_found", 404);
  }

  const ip = getClientIp(context.request);
  const vip = Number(member.vip);
  const startTime = Number(member.start_time) || 0;
  const endTime = Number(member.end_time) || 0;

  try {
    switch (action) {
      case "renew": {
        const days = body.days;
        if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
          return errorResponse(400, "invalid_days", 400);
        }
        const newEnd = Math.max(serverTime, endTime) + days * DAY;
        let newStart = startTime;
        // 原 vip=0 则重新授权，start_time 重置为当前
        if (vip === 0) {
          newStart = serverTime;
        }
        await db
          .prepare(`UPDATE members SET vip = 1, start_time = ?, end_time = ?, updated_at = ? WHERE id = ?`)
          .bind(newStart, newEnd, serverTime, id)
          .run();

        await writeOpLog(db, { action: "renew", target: member.phone, detail: "+" + days + "天", result: "success", admin: context.data.admin, ip });

        const updated = { ...member, vip: 1, start_time: newStart, end_time: newEnd, updated_at: serverTime };
        return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
      }

      case "disable": {
        await db
          .prepare(`UPDATE members SET vip = 0, updated_at = ? WHERE id = ?`)
          .bind(serverTime, id)
          .run();

        await writeOpLog(db, { action: "disable", target: member.phone, detail: null, result: "success", admin: context.data.admin, ip });

        const updated = { ...member, vip: 0, updated_at: serverTime };
        return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
      }

      case "restore": {
        // 是否传入 days 必须按属性存在性判断，不能只看 truthy
        const hasDays = body != null && Object.prototype.hasOwnProperty.call(body, "days");
        const expired = endTime <= serverTime;

        if (!expired) {
          // 未过期：保留原始起止时间，只恢复状态
          if (hasDays) {
            return errorResponse(400, "invalid_state", 400);
          }
          await db
            .prepare(`UPDATE members SET vip = 1, updated_at = ? WHERE id = ?`)
            .bind(serverTime, id)
            .run();

          await writeOpLog(db, { action: "restore", target: member.phone, detail: null, result: "success", admin: context.data.admin, ip });

          const updated = { ...member, vip: 1, updated_at: serverTime };
          return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
        }

        // 已过期：必须由管理员填写延长天数
        if (!hasDays) {
          return errorResponse(400, "days_required", 400);
        }
        const days = body.days;
        if (typeof days !== "number" || !Number.isSafeInteger(days) || days < 1 || days > MAX_DAYS) {
          return errorResponse(400, "invalid_days", 400);
        }

        // 已过期恢复：以服务端时间为新起点，避免恢复后仍过期
        const newStart = serverTime;
        const newEnd = serverTime + days * DAY;
        await db
          .prepare(`UPDATE members SET vip = 1, start_time = ?, end_time = ?, updated_at = ? WHERE id = ?`)
          .bind(newStart, newEnd, serverTime, id)
          .run();

        await writeOpLog(db, { action: "restore", target: member.phone, detail: null, result: "success", admin: context.data.admin, ip });

        const updated = { ...member, vip: 1, start_time: newStart, end_time: newEnd, updated_at: serverTime };
        return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
      }

      case "editPhone": {
        const phone = String(body.phone || "").trim();
        if (!PHONE_RE.test(phone)) {
          return errorResponse(400, "invalid_phone", 400);
        }
        // 排除自身查重
        const exist = await db
          .prepare("SELECT id FROM members WHERE phone = ? AND id != ? LIMIT 1")
          .bind(phone, id)
          .first();
        if (exist) {
          return errorResponse(409, "phone_exists", 409);
        }
        await db
          .prepare(`UPDATE members SET phone = ?, updated_at = ? WHERE id = ?`)
          .bind(phone, serverTime, id)
          .run();

        await writeOpLog(db, { action: "edit_phone", target: member.phone, detail: member.phone + " → " + phone, result: "success", admin: context.data.admin, ip });

        const updated = { ...member, phone, updated_at: serverTime };
        return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
      }

      case "editDevice": {
        const deviceId = String(body.deviceId || "").trim();
        if (!deviceId) {
          return errorResponse(400, "device_id_required", 400);
        }
        if (deviceId.length > 128) {
          return errorResponse(400, "device_id_too_long", 400);
        }
        const exist = await db
          .prepare("SELECT id FROM members WHERE device_id = ? AND id != ? LIMIT 1")
          .bind(deviceId, id)
          .first();
        if (exist) {
          return errorResponse(409, "device_id_exists", 409);
        }
        await db
          .prepare(`UPDATE members SET device_id = ?, updated_at = ? WHERE id = ?`)
          .bind(deviceId, serverTime, id)
          .run();

        await writeOpLog(db, { action: "edit_device", target: member.phone, detail: maskDev(member.device_id) + " → " + maskDev(deviceId), result: "success", admin: context.data.admin, ip });

        const updated = { ...member, device_id: deviceId, updated_at: serverTime };
        return jsonResponse({ code: 0, msg: "updated", data: mapRow(updated, serverTime), serverTime });
      }

      default:
        return errorResponse(400, "invalid_action", 400);
    }
  } catch (err) {
    if (isUniqueConstraintError(err)) {
      const msg = /phone/i.test(String(err.message || err)) ? "phone_exists" : "device_id_exists";
      return errorResponse(409, msg, 409);
    }
    console.error("[admin/members/:id] patch error:", err);
    return errorResponse(500, "member_update_failed", 500);
  }
}

function maskDev(id) {
  if (!id) return "";
  if (id.length <= 10) return id;
  return id.slice(0, 6) + "…" + id.slice(-4);
}

export async function onRequestGet(context) {
  return handleGet(context);
}

export async function onRequestPatch(context) {
  return handlePatch(context);
}

export async function onRequest(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;
  return methodNotAllowed("GET, PATCH");
}

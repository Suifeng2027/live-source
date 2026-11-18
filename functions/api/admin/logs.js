// GET /api/admin/logs  操作日志查询

import { jsonResponse, errorResponse, methodNotAllowed } from "../../_lib/response.js";
import { checkAdminAuth } from "../../_lib/auth.js";

const MAX_PAGE_SIZE = 100;

async function handleGet(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;

  const serverTime = Math.floor(Date.now() / 1000);
  const db = context.env.MEMBERS_DB;
  if (!db) return errorResponse(500, "MEMBERS_DB not configured", 500);

  const url = new URL(context.request.url);
  // type 与 action 都支持，向前兼容
  const type = (url.searchParams.get("type") || url.searchParams.get("action") || "").trim();
  const page = Math.max(1, parseInt(url.searchParams.get("page") || "1", 10) || 1);
  let pageSize = parseInt(url.searchParams.get("pageSize") || "20", 10) || 20;
  if (pageSize < 1) pageSize = 20;
  if (pageSize > MAX_PAGE_SIZE) pageSize = MAX_PAGE_SIZE;

  const conditions = [];
  const params = [];
  if (type) {
    conditions.push("action = ?");
    params.push(type);
  }
  const where = conditions.length ? "WHERE " + conditions.join(" AND ") : "";

  try {
    const countRow = await db
      .prepare(`SELECT COUNT(*) AS c FROM op_logs ${where}`)
      .bind(...params)
      .first();
    const total = Number(countRow && countRow.c) || 0;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const offset = (page - 1) * pageSize;

    const rows = await db
      .prepare(`
        SELECT id, created_at, admin, action, target, detail, result, ip
        FROM op_logs
        ${where}
        ORDER BY id DESC
        LIMIT ? OFFSET ?
      `)
      .bind(...params, pageSize, offset)
      .all();

    const list = (rows || []).map(r => ({
      id: r.id,
      time: Number(r.created_at) || 0,
      admin: r.admin,
      action: r.action,
      target: r.target,
      detail: r.detail,
      result: r.result,
      ip: r.ip
    }));

    return jsonResponse({
      code: 0,
      data: { list, total, page, pageSize, totalPages },
      serverTime
    });
  } catch (err) {
    console.error("[admin/logs] query error:", err);
    return errorResponse(500, "logs_query_failed", 500);
  }
}

export async function onRequestGet(context) {
  return handleGet(context);
}

export async function onRequest(context) {
  const authErr = await checkAdminAuth(context);
  if (authErr) return authErr;
  return methodNotAllowed("GET");
}

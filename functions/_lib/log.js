// 操作日志写入
// 所有写操作成功后调用 writeOpLog 记录审计日志
// 日志写入失败不阻塞主操作，仅 console.error 记录

// 获取客户端真实 IP
export function getClientIp(request) {
  const cfIp = request.headers.get("CF-Connecting-IP");
  if (cfIp) return cfIp;
  const xff = request.headers.get("X-Forwarded-For");
  if (xff) return xff.split(",")[0].trim();
  return null;
}

// 写入操作日志
// 参数: db, { admin, action, target, detail, result, ip }
export async function writeOpLog(db, opts = {}) {
  try {
    const now = Math.floor(Date.now() / 1000);
    const admin = typeof opts.admin === "string" && opts.admin.trim() ? opts.admin.trim() : "unknown";
    const action = opts.action || "";
    const target = opts.target != null ? opts.target : null;
    const detail = opts.detail != null ? opts.detail : null;
    const result = opts.result || "success";
    const ip = opts.ip != null ? opts.ip : null;

    if (!action) return;

    await db
      .prepare(`
        INSERT INTO op_logs (created_at, admin, action, target, detail, result, ip)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `)
      .bind(now, admin, action, target, detail, result, ip)
      .run();
  } catch (e) {
    // 日志写入失败不能影响已成功的主操作
    console.error("[op_log] write failed:", e);
  }
}

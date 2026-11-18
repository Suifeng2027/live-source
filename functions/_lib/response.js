// 统一 JSON 响应封装
// 所有管理 API 响应统一使用此模块，确保 Content-Type 与 Cache-Control 一致

export function jsonResponse(data, status = 200) {
  return new Response(
    JSON.stringify(data),
    {
      status,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate"
      }
    }
  );
}

// 统一错误响应，自动附带 serverTime（Unix 秒）
export function errorResponse(code, msg, status, extras = {}) {
  const serverTime = Math.floor(Date.now() / 1000);
  return jsonResponse({ code, msg, serverTime, ...extras }, status);
}

// 405 Method Not Allowed
export function methodNotAllowed(allow) {
  const serverTime = Math.floor(Date.now() / 1000);
  return new Response(
    JSON.stringify({ code: 405, msg: "method_not_allowed", serverTime }),
    {
      status: 405,
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store, no-cache, must-revalidate",
        "Allow": allow
      }
    }
  );
}

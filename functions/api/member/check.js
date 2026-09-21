export async function onRequestGet(context) {
    const url = new URL(context.request.url);
    const deviceId = (url.searchParams.get("deviceId") || "").trim();

    // 服务器时间，Unix 秒
    const serverTime = Math.floor(Date.now() / 1000);

    // 缺少设备 ID
    if (!deviceId) {
        return jsonResponse({
            code: 400,
            msg: "deviceId required",
            serverTime: serverTime
        }, 400);
    }

    try {
        const db = context.env.MEMBERS_DB;

        // D1 Binding 未配置
        if (!db) {
            return jsonResponse({
                code: 500,
                msg: "MEMBERS_DB not configured",
                serverTime: serverTime
            }, 500);
        }

        const row = await db
            .prepare(`
                SELECT
                    device_id,
                    vip,
                    start_time,
                    end_time
                FROM members
                WHERE device_id = ?
                LIMIT 1
            `)
            .bind(deviceId)
            .first();

        // 未找到设备
        if (!row) {
            return jsonResponse({
                code: 0,
                vip: false,
                startTime: 0,
                endTime: 0,
                serverTime: serverTime
            });
        }

        const startTime = Number(row.start_time) || 0;
        const endTime = Number(row.end_time) || 0;

        const vipFlag = Number(row.vip) === 1;

        // 必须同时满足：
        // 1. vip = 1
        // 2. 当前服务器时间 >= startTime
        // 3. 当前服务器时间 <= endTime
        const vip =
            vipFlag &&
            startTime > 0 &&
            endTime > 0 &&
            serverTime >= startTime &&
            serverTime <= endTime;

        return jsonResponse({
            code: 0,
            vip: vip,
            startTime: startTime,
            endTime: endTime,
            serverTime: serverTime
        });

    } catch (error) {
        console.error("[Member] check error:", error);

        return jsonResponse({
            code: 500,
            msg: "member check failed",
            serverTime: serverTime
        }, 500);
    }
}


function jsonResponse(data, status = 200) {
    return new Response(
        JSON.stringify(data),
        {
            status: status,
            headers: {
                "Content-Type": "application/json; charset=utf-8",
                "Cache-Control": "no-store, no-cache, must-revalidate"
            }
        }
    );
}

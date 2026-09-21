export async function onRequestPost(context) {
    const serverTime = Math.floor(Date.now() / 1000);

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

        // 读取 POST JSON
        let body;

        try {
            body = await context.request.json();
        } catch (error) {
            return jsonResponse({
                code: 400,
                msg: "invalid json",
                serverTime: serverTime
            }, 400);
        }

        const phone = String(body.phone || "").trim();
        const deviceId = String(body.deviceId || "").trim();

        // 手机号不能为空
        if (!phone) {
            return jsonResponse({
                code: 400,
                msg: "phone required",
                serverTime: serverTime
            }, 400);
        }

        // 设备 ID 不能为空
        if (!deviceId) {
            return jsonResponse({
                code: 400,
                msg: "deviceId required",
                serverTime: serverTime
            }, 400);
        }

        // 中国大陆手机号格式
        if (!/^1[3-9][0-9]{9}$/.test(phone)) {
            return jsonResponse({
                code: 400,
                msg: "invalid_phone",
                serverTime: serverTime
            }, 400);
        }

        // 防止异常超长 deviceId
        if (deviceId.length > 128) {
            return jsonResponse({
                code: 400,
                msg: "deviceId too long",
                serverTime: serverTime
            }, 400);
        }

        // 查询手机号对应的会员
        let row = await db
            .prepare(`
                SELECT
                    id,
                    phone,
                    device_id,
                    vip,
                    start_time,
                    end_time
                FROM members
                WHERE phone = ?
                LIMIT 1
            `)
            .bind(phone)
            .first();

        // =========================================================
        // 情况 1：手机号不存在
        // 自动创建会员账号，但默认不是会员
        // =========================================================
        if (!row) {
            try {
                await db
                    .prepare(`
                        INSERT INTO members (
                            phone,
                            device_id,
                            vip,
                            start_time,
                            end_time,
                            created_at,
                            updated_at,
                            last_seen
                        )
                        VALUES (?, ?, 0, 0, 0, ?, ?, ?)
                    `)
                    .bind(
                        phone,
                        deviceId,
                        serverTime,
                        serverTime,
                        serverTime
                    )
                    .run();

            } catch (insertError) {
                // 处理并发情况下手机号唯一索引冲突
                row = await db
                    .prepare(`
                        SELECT
                            id,
                            phone,
                            device_id,
                            vip,
                            start_time,
                            end_time
                        FROM members
                        WHERE phone = ?
                        LIMIT 1
                    `)
                    .bind(phone)
                    .first();

                if (!row) {
                    console.error("[Member] register failed:", insertError);

                    return jsonResponse({
                        code: 500,
                        msg: "member register failed",
                        serverTime: serverTime
                    }, 500);
                }
            }

            // 如果成功创建，直接返回非会员
            if (!row) {
                return jsonResponse({
                    code: 0,
                    msg: "registered",
                    vip: false,
                    startTime: 0,
                    endTime: 0,
                    serverTime: serverTime
                });
            }
        }

        // =========================================================
        // 情况 2：手机号已经存在
        // 检查设备是否一致
        // =========================================================

        const registeredDeviceId = String(row.device_id || "");

        if (registeredDeviceId !== deviceId) {
            return jsonResponse({
                code: 403,
                msg: "device_mismatch",
                serverTime: serverTime
            }, 403);
        }

        // 更新最后访问时间
        await db
            .prepare(`
                UPDATE members
                SET
                    last_seen = ?,
                    updated_at = ?
                WHERE id = ?
            `)
            .bind(
                serverTime,
                serverTime,
                row.id
            )
            .run();

        const startTime = Number(row.start_time) || 0;
        const endTime = Number(row.end_time) || 0;
        const vipFlag = Number(row.vip) === 1;

        const vip =
            vipFlag &&
            startTime > 0 &&
            endTime > 0 &&
            serverTime >= startTime &&
            serverTime <= endTime;

        return jsonResponse({
            code: 0,
            msg: "success",
            vip: vip,
            startTime: startTime,
            endTime: endTime,
            serverTime: serverTime
        });

    } catch (error) {
        console.error("[Member] activate error:", error);

        return jsonResponse({
            code: 500,
            msg: "member activate failed",
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

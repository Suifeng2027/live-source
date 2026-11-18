-- ============================================================
-- MYTV 管理后台 - 操作日志表
-- 此脚本需通过 wrangler d1 execute 单独执行，不在 Functions 中运行
-- 仅本地开发环境使用，禁止对线上库执行未经审批的 DDL
-- ============================================================

CREATE TABLE IF NOT EXISTS op_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  created_at INTEGER NOT NULL,
  admin TEXT NOT NULL DEFAULT 'admin',
  action TEXT NOT NULL,
  target TEXT,
  detail TEXT,
  result TEXT NOT NULL,
  ip TEXT
);

CREATE INDEX IF NOT EXISTS idx_op_logs_created_at ON op_logs(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_op_logs_action ON op_logs(action);

-- action 取值范围: create | renew | disable | restore | edit_phone | edit_device
-- result 取值: success | fail

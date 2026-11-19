/* ==========================================================================
   MYTV会员管理后台 - 前端交互逻辑
   纯本地模拟，不调用任何后端 API，不连接线上数据库
   ========================================================================== */

(function () {
  'use strict';

  // ========== 工具函数 ==========
  const $ = (id) => document.getElementById(id);
  const nowSec = () => Math.floor(Date.now() / 1000);
  const DAY = 86400;

  function pad(n) { return n < 10 ? '0' + n : '' + n; }
  function fmtDate(sec) {
    if (!sec || sec <= 0) return '—';
    const d = new Date(sec * 1000);
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
      + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
  }
  function daysLeft(m) {
    if (!m.end_time || m.end_time <= 0) return -999;
    return Math.ceil((m.end_time - nowSec()) / DAY);
  }
  const STATUS_LABELS = {
    active: '有效',
    expiring: '即将到期',
    expired: '已过期',
    disabled: '已停用',
    not_started: '未开始'
  };

  // 优先使用服务端返回的 status（真实会员），缺失时才按模拟字段本地计算
  function statusOf(m) {
    if (m && typeof m.status === 'string' && STATUS_LABELS[m.status]) return m.status;
    if (m.vip === 0) return 'disabled';
    const left = daysLeft(m);
    if (left < 0) return 'expired';
    if (left <= 30) return 'expiring';
    return 'active';
  }
  function statusLabel(s) {
    return STATUS_LABELS[s] || s;
  }
  function maskDevice(id) {
    if (!id) return '—';
    if (id.length <= 10) return id;
    return id.slice(0, 6) + '…' + id.slice(-4);
  }
  function randHex(len) {
    let s = '';
    const chars = '0123456789abcdef';
    for (let i = 0; i < len; i++) s += chars[Math.floor(Math.random() * 16)];
    return s;
  }
  function randPhone() {
    const prefixes = ['138', '139', '137', '135', '158', '159', '186', '187', '188', '176', '177', '199'];
    let p = prefixes[Math.floor(Math.random() * prefixes.length)];
    for (let i = 0; i < 8; i++) p += Math.floor(Math.random() * 10);
    return p;
  }
  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  const PHONE_RE = /^1[3-9][0-9]{9}$/;

  // ========== API 公共请求封装 ==========
  // 仅提供统一的同源请求能力，本阶段不被任何业务代码调用。
  // 认证由 Cloudflare Access 在边缘完成，前端不携带密钥，也不自行添加任何认证头。
  const API_BASE = '/api/admin';
  const API_TIMEOUT_MS = 10000;

  // 统一错误对象：至少含 status / code / msg / type
  function apiError(type, status, code, msg) {
    const err = new Error(msg || type);
    err.name = 'ApiError';
    err.type = type;
    err.status = status;
    err.code = code;
    err.msg = msg || '';
    return err;
  }

  function isJsonResponse(response) {
    const ct = response.headers.get('Content-Type') || '';
    return ct.toLowerCase().indexOf('application/json') !== -1;
  }

  // 仅在 Content-Type 为 JSON 时才解析，避免把 HTML 当 JSON 处理
  async function readJsonSafely(response) {
    if (!isJsonResponse(response)) return null;
    try {
      return await response.json();
    } catch (_e) {
      return null;
    }
  }

  async function api(method, path, body) {
    const upper = String(method || 'GET').toUpperCase();
    const url = API_BASE + (path || '');
    const headers = { 'Accept': 'application/json' };
    const options = { method: upper, headers: headers, redirect: 'manual' };

    if (body !== undefined && body !== null) {
      headers['Content-Type'] = 'application/json';
      options.body = JSON.stringify(body);
    }

    // 10 秒超时（不改变默认同源凭据策略）
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    let timer = null;
    let timeoutTask = null;
    if (controller) {
      options.signal = controller.signal;
      timeoutTask = new Promise((_resolve, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(apiError('timeout', 0, 0, '请求超时（' + API_TIMEOUT_MS + 'ms）'));
        }, API_TIMEOUT_MS);
      });
    }

    let response;
    try {
      response = controller
        ? await Promise.race([fetch(url, options), timeoutTask])
        : await fetch(url, options);
    } catch (e) {
      if (e && e.type === 'timeout') throw e;
      // 跨域重定向被浏览器直接拒绝时也落到这里，此时无法确认具体原因
      throw apiError('network_error', 0, 0, '网络异常或响应不可用');
    } finally {
      if (timer) clearTimeout(timer);
    }

    const status = typeof response.status === 'number' ? response.status : 0;

    // redirect: "manual" 下重定向会得到 status=0 的不透明响应，不解析其内容
    if (response.type === 'opaqueredirect' || status === 0 || (status >= 300 && status < 400)) {
      throw apiError('access_redirect', status, status, '请求被重定向，可能需要重新完成 Access 登录');
    }

    if (!response.ok) {
      const payload = await readJsonSafely(response);
      const backendCode = payload && typeof payload.code === 'number' ? payload.code : status;
      const backendMsg = payload && typeof payload.msg === 'string' ? payload.msg : '';
      const type = status === 401 ? 'unauthorized'
        : status === 403 ? 'forbidden'
        : status === 503 ? 'auth_unavailable'
        : 'http_error';
      const fallback = type === 'unauthorized' ? '未通过身份验证'
        : type === 'forbidden' ? '无权限访问'
        : type === 'auth_unavailable' ? '认证服务暂不可用'
        : 'HTTP ' + status;
      throw apiError(type, status, backendCode, backendMsg || fallback);
    }

    if (!isJsonResponse(response)) {
      throw apiError('invalid_content_type', status, status, '响应不是 application/json');
    }
    try {
      return await response.json();
    } catch (_e) {
      throw apiError('invalid_json', status, status, '响应 JSON 解析失败');
    }
  }

  // ========== 模拟会员数据（全部虚构） ==========
  const NOW = nowSec();
  let idSeed = 1000;

  function makeMember(opts) {
    const start = opts.start != null ? opts.start : NOW - Math.floor(Math.random() * 200) * DAY;
    const end = opts.end != null ? opts.end : start + (opts.days || 30) * DAY;
    return {
      id: ++idSeed,
      phone: opts.phone || randPhone(),
      device_id: opts.device_id || randHex(16),
      vip: opts.vip != null ? opts.vip : 1,
      start_time: start,
      end_time: end,
      created_at: start,
      updated_at: NOW,
      last_seen: opts.last_seen != null ? opts.last_seen : NOW - Math.floor(Math.random() * 7) * DAY,
      remark: opts.remark || ''
    };
  }

  let members = [
    makeMember({ days: 365 }),
    makeMember({ days: 180 }),
    makeMember({ days: 90 }),
    makeMember({ days: 30 }),
    makeMember({ days: 15 }),
    makeMember({ days: 7 }),
    makeMember({ days: 3 }),
    makeMember({ days: 1 }),
    makeMember({ days: 365, end: NOW - 5 * DAY }),
    makeMember({ days: 365, end: NOW - 30 * DAY }),
    makeMember({ vip: 0, days: 0 }),
    makeMember({ vip: 0, days: 0 }),
    makeMember({ vip: 0, days: 0 }),
    makeMember({ days: 200 }),
    makeMember({ days: 120 }),
    makeMember({ days: 60 }),
    makeMember({ days: 45 }),
    makeMember({ days: 20 }),
    makeMember({ days: 10 }),
    makeMember({ days: 5 }),
    makeMember({ days: 365 }),
    makeMember({ days: 180 }),
    makeMember({ days: 90 }),
    makeMember({ days: 250 })
  ];

  // ========== 操作日志（模拟） ==========
  let logs = [
    { time: NOW - 3600 * 2, admin: '管理员', type: '新增会员', target: members[0].phone, result: '成功' },
    { time: NOW - 3600 * 5, admin: '管理员', type: '续费', target: members[1].phone, result: '成功 +180天' },
    { time: NOW - 3600 * 8, admin: '管理员', type: '修改设备ID', target: members[2].phone, result: '成功' },
    { time: NOW - 86400, admin: '管理员', type: '停用会员', target: members[10].phone, result: '成功' },
    { time: NOW - 86400 * 2, admin: '管理员', type: '修改手机号', target: members[3].phone, result: '成功' },
    { time: NOW - 86400 * 3, admin: '管理员', type: '恢复会员', target: members[11].phone, result: '成功' }
  ];

  function addLog(type, target, result) {
    logs.unshift({ time: nowSec(), admin: '管理员', type, target, result });
  }

  // ========== 页面状态 ==========
  const state = {
    view: 'dashboard',
    page: 1,
    pageSize: 10,
    filters: { phone: '', device: '', status: '', expire: '' },
    // 会员列表的服务端分页缓存（真实数据），与模拟数组 members 完全隔离
    memberPage: {
      list: [],
      total: 0,
      page: 1,
      pageSize: 10,
      totalPages: 1,
      loading: false,
      error: null,
      loaded: false
    }
  };

  // ========== Toast 提示 ==========
  function toast(msg, type) {
    const el = document.createElement('div');
    el.className = 'toast' + (type === 'error' ? ' error' : type === 'warning' ? ' warning' : '');
    el.textContent = msg;
    $('toastContainer').appendChild(el);
    setTimeout(() => { el.style.opacity = '0'; el.style.transition = 'opacity 0.3s'; }, 2200);
    setTimeout(() => el.remove(), 2600);
  }

  // ========== 弹窗 ==========
  function openModal(html) {
    $('modalContent').innerHTML = html;
    $('modalOverlay').classList.add('show');
  }
  function closeModal() {
    $('modalOverlay').classList.remove('show');
    $('modalContent').innerHTML = '';
  }

  // ========== 导航切换 ==========
  const VIEW_META = {
    dashboard: { title: '首页概览', subtitle: '数据为本地模拟，未连接线上服务' },
    members: { title: '会员管理', subtitle: '搜索、筛选、续费、停用等操作均为本地模拟' },
    expiring: { title: '即将到期', subtitle: '有效期剩余 30 天以内的会员' },
    disabled: { title: '已停用会员', subtitle: 'vip=0 的会员记录' },
    logs: { title: '操作日志', subtitle: '所有操作均记录到本地日志（模拟）' },
    settings: { title: '系统设置', subtitle: '演示配置，修改仅在本地生效' }
  };

  function showView(name) {
    state.view = name;
    document.querySelectorAll('.nav-item').forEach(a => {
      a.classList.toggle('active', a.dataset.view === name);
    });
    document.querySelectorAll('.view').forEach(v => {
      v.classList.toggle('active', v.id === 'view-' + name);
    });
    const meta = VIEW_META[name];
    $('pageTitle').innerHTML = meta.title + ' <span class="demo-tag">DEMO</span>';
    $('pageSubtitle').textContent = meta.subtitle;
    closeSidebar();
    render();
  }

  function render() {
    switch (state.view) {
      case 'dashboard': renderDashboard(); break;
      case 'members':
        renderMembers();
        // 首次进入会员管理视图才加载；失败后不自动重试，等待用户显式点击刷新
        if (!state.memberPage.loaded && !state.memberPage.loading && !state.memberPage.error) loadMembers();
        break;
      case 'expiring': renderExpiring(); break;
      case 'disabled': renderDisabled(); break;
      case 'logs': renderLogs(); break;
      case 'settings': break;
    }
  }

  // ========== 首页概览 ==========
  function renderDashboard() {
    const total = members.length;
    const active = members.filter(m => statusOf(m) === 'active').length;
    const expiring = members.filter(m => statusOf(m) === 'expiring').length;
    const disabled = members.filter(m => statusOf(m) === 'disabled').length;
    $('statTotal').textContent = total;
    $('statActive').textContent = active;
    $('statExpiring').textContent = expiring;
    $('statDisabled').textContent = disabled;
    renderGrowthChart();
    renderRecentLogs();
  }

  function renderGrowthChart() {
    const points = [];
    let base = Math.floor(members.length * 0.4);
    const now = new Date();
    for (let i = 11; i >= 0; i--) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      base += Math.floor(Math.random() * 8) + 1;
      points.push({ label: (d.getMonth() + 1) + '月', value: base });
    }
    const W = 720, H = 260, PAD = { l: 40, r: 16, t: 16, b: 30 };
    const cw = W - PAD.l - PAD.r, ch = H - PAD.t - PAD.b;
    const max = Math.max(...points.map(p => p.value)) * 1.15;
    const stepX = cw / (points.length - 1);
    const y = (v) => PAD.t + ch - (v / max) * ch;
    const x = (i) => PAD.l + i * stepX;

    let path = '';
    points.forEach((p, i) => {
      path += (i === 0 ? 'M' : 'L') + x(i).toFixed(1) + ',' + y(p.value).toFixed(1) + ' ';
    });
    const area = path + `L${x(points.length - 1)},${PAD.t + ch} L${x(0)},${PAD.t + ch} Z`;

    let svg = `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">`;
    for (let i = 0; i <= 4; i++) {
      const gy = PAD.t + (ch / 4) * i;
      const val = Math.round(max - (max / 4) * i);
      svg += `<line x1="${PAD.l}" y1="${gy}" x2="${W - PAD.r}" y2="${gy}" stroke="#30363d" stroke-width="1"/>`;
      svg += `<text x="${PAD.l - 6}" y="${gy + 4}" fill="#6e7681" font-size="11" text-anchor="end">${val}</text>`;
    }
    svg += `<path d="${area}" fill="rgba(16,185,129,0.12)"/>`;
    svg += `<path d="${path}" fill="none" stroke="#10b981" stroke-width="2.5" stroke-linejoin="round"/>`;
    points.forEach((p, i) => {
      svg += `<circle cx="${x(i)}" cy="${y(p.value)}" r="3.5" fill="#10b981"/>`;
      svg += `<text x="${x(i)}" y="${H - 10}" fill="#8b949e" font-size="11" text-anchor="middle">${p.label}</text>`;
    });
    svg += '</svg>';
    $('growthChart').innerHTML = svg;
  }

  function renderRecentLogs() {
    const list = logs.slice(0, 5);
    $('recentLogs').innerHTML = list.map(l => `
      <div style="display:flex;justify-content:space-between;align-items:center;padding:10px 0;border-bottom:1px solid var(--border);font-size:13px;">
        <div><strong>${escapeHtml(l.type)}</strong> · ${escapeHtml(l.target)} <span style="color:var(--text-muted);">· ${escapeHtml(l.result)}</span></div>
        <div style="color:var(--text-muted);font-size:12px;">${fmtDate(l.time)}</div>
      </div>
    `).join('') || '<div style="color:var(--text-muted);padding:12px 0;">暂无记录</div>';
  }

  // ========== 会员筛选 ==========
  // 说明：S2 起会员列表改用服务端分页数据，本函数不再参与列表渲染（S3 接入服务端筛选后统一处理）
  function getFilteredMembers() {
    const f = state.filters;
    return members.filter(m => {
      if (f.phone && !m.phone.includes(f.phone.trim())) return false;
      if (f.device && !m.device_id.toLowerCase().includes(f.device.trim().toLowerCase())) return false;
      if (f.status && statusOf(m) !== f.status) return false;
      if (f.expire) {
        if (f.expire === 'expired') {
          if (statusOf(m) !== 'expired') return false;
        } else {
          const left = daysLeft(m);
          if (left < 0 || left > parseInt(f.expire, 10)) return false;
        }
      }
      return true;
    });
  }

  // ========== 会员管理 ==========
  // 后端 DTO（camelCase）→ 本项目渲染所需字段（snake_case）
  function normalizeMember(dto) {
    const src = dto || {};
    const num = (v) => {
      const n = Number(v);
      return Number.isFinite(n) ? n : 0;
    };
    return {
      id: num(src.id),
      phone: src.phone == null ? '' : String(src.phone),
      device_id: src.deviceId == null ? '' : String(src.deviceId),
      vip: num(src.vip),
      start_time: num(src.startTime),
      end_time: num(src.endTime),
      last_seen: num(src.lastSeen),
      created_at: num(src.createdAt),
      updated_at: num(src.updatedAt),
      status: typeof src.status === 'string' ? src.status : '',
      days_left: num(src.daysLeft),
      remark: ''
    };
  }

  // 拉取会员列表（后端分页）。本阶段只服务「会员管理」列表，不影响模拟数据
  async function loadMembers() {
    const p = state.memberPage;
    if (p.loading) return; // 防止并发重复请求

    p.loading = true;
    p.error = null;
    renderMembers(); // 首次显示「加载中…」，翻页时保留旧表格并提示加载中

    const query = '?page=' + encodeURIComponent(state.page)
      + '&pageSize=' + encodeURIComponent(state.pageSize);

    try {
      const res = await api('GET', '/members' + query);
      const data = res && res.data ? res.data : null;
      if (!data || !Array.isArray(data.list)) {
        throw apiError('invalid_json', 200, 200, '返回数据格式异常');
      }

      p.list = data.list.map(normalizeMember);
      p.total = Number(data.total) || 0;
      p.totalPages = Number(data.totalPages) > 0 ? Number(data.totalPages) : 1;
      p.page = Number(data.page) > 0 ? Number(data.page) : state.page;
      p.pageSize = Number(data.pageSize) > 0 ? Number(data.pageSize) : state.pageSize;
      p.loaded = true;
      p.loading = false;
      p.error = null;
      state.page = p.page;

      // 页码越界（例如数据减少）：回写到最后有效页并重取一次
      if (p.list.length === 0 && p.total > 0 && p.page > p.totalPages) {
        state.page = p.totalPages;
        return loadMembers();
      }

      renderMembers();
    } catch (err) {
      p.loading = false;
      p.loaded = false;
      p.list = []; // 失败时清空，绝不让旧数据或模拟数据冒充真实数据
      p.total = 0;
      p.totalPages = 1;
      p.error = (err && (err.msg || err.message)) ? String(err.msg || err.message) : '未知错误';
      renderMembers();
    }
  }

  function actionButtons(m, locked) {
    // 真实会员行：这些操作尚未接入 API，明确禁用，避免误调模拟逻辑或真实 ID 与模拟 ID 碰撞
    if (locked) {
      const dis = 'disabled title="该操作将在后续阶段接入真实接口" style="opacity:.45;cursor:not-allowed;"';
      return `
      <div class="row-actions">
        <button class="action-btn" ${dis}>详情</button>
        <button class="action-btn" ${dis}>续费</button>
        <button class="action-btn" ${dis}>改手机号</button>
        <button class="action-btn" ${dis}>改设备ID</button>
        <button class="action-btn danger" ${dis}>停用</button>
      </div>`;
    }
    const s = statusOf(m);
    const disableBtn = s !== 'disabled'
      ? `<button class="action-btn danger" data-act="disable" data-id="${m.id}">停用</button>`
      : `<button class="action-btn" data-act="restore" data-id="${m.id}">恢复</button>`;
    return `
      <div class="row-actions">
        <button class="action-btn" data-act="view" data-id="${m.id}">详情</button>
        <button class="action-btn" data-act="renew" data-id="${m.id}">续费</button>
        <button class="action-btn" data-act="phone" data-id="${m.id}">改手机号</button>
        <button class="action-btn" data-act="device" data-id="${m.id}">改设备ID</button>
        ${disableBtn}
      </div>`;
  }

  function memberRow(m, locked) {
    const s = statusOf(m);
    // not_started 无独立 badge 样式，复用 active 外观但保留正确文案
    const badgeClass = s === 'not_started' ? 'active' : s;
    return `<tr>
      <td>${m.id}</td>
      <td>${escapeHtml(m.phone)}</td>
      <td title="${escapeHtml(m.device_id)}">${escapeHtml(maskDevice(m.device_id))}</td>
      <td><span class="badge ${badgeClass}">${statusLabel(s)}</span></td>
      <td>${fmtDate(m.start_time)}</td>
      <td>${fmtDate(m.end_time)}</td>
      <td>${fmtDate(m.last_seen)}</td>
      <td>${actionButtons(m, locked)}</td>
    </tr>`;
  }

  function renderMembers() {
    const p = state.memberPage;

    // 失败：只显示错误与重试入口，不回退旧数据或模拟数据
    if (p.error) {
      $('memberTable').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--danger);padding:40px 0;">加载失败：${escapeHtml(p.error)}<br><button class="page-btn" id="memberReloadBtn" style="margin-top:12px;">重新加载</button></td></tr>`;
      $('pageInfo').textContent = '加载失败';
      renderPageButtons(1);
      const reloadBtn = $('memberReloadBtn');
      if (reloadBtn) reloadBtn.addEventListener('click', () => loadMembers());
      return;
    }

    // 首次加载：整表显示加载中
    if (p.loading && !p.loaded) {
      $('memberTable').innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px 0;">加载中…</td></tr>`;
      $('pageInfo').textContent = '加载中…';
      renderPageButtons(1);
      return;
    }

    const list = p.list;
    $('memberTable').innerHTML = list.map(m => memberRow(m, true)).join('')
      || `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);padding:40px 0;">暂无会员数据</td></tr>`;

    $('pageInfo').textContent = `共 ${p.total} 条，第 ${p.page} / ${p.totalPages} 页` + (p.loading ? '（加载中…）' : '');
    renderPageButtons(p.totalPages);
    bindMemberActions();
  }

  function renderPageButtons(totalPages) {
    let html = `<button class="page-btn" data-page="${state.page - 1}" ${state.page <= 1 ? 'disabled' : ''}>上一页</button>`;
    for (let i = 1; i <= totalPages; i++) {
      if (totalPages > 7 && Math.abs(i - state.page) > 2 && i !== 1 && i !== totalPages) {
        if (i === 2 || i === totalPages - 1) html += `<span class="page-btn" style="border:none;">…</span>`;
        continue;
      }
      html += `<button class="page-btn ${i === state.page ? 'active' : ''}" data-page="${i}">${i}</button>`;
    }
    html += `<button class="page-btn" data-page="${state.page + 1}" ${state.page >= totalPages ? 'disabled' : ''}>下一页</button>`;
    $('pageButtons').innerHTML = html;
    $('pageButtons').querySelectorAll('.page-btn[data-page]').forEach(btn => {
      btn.addEventListener('click', () => {
        const p = parseInt(btn.dataset.page, 10);
        if (p >= 1 && p <= totalPages) { state.page = p; loadMembers(); }
      });
    });
  }

  function bindMemberActions() {
    $('memberTable').querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        const act = btn.dataset.act;
        if (act === 'view') viewDetail(id);
        else if (act === 'renew') renewMember(id);
        else if (act === 'phone') editPhone(id);
        else if (act === 'device') editDevice(id);
        else if (act === 'disable') disableMember(id);
        else if (act === 'restore') restoreMember(id);
      });
    });
  }

  // ========== 即将到期 ==========
  function renderExpiring() {
    const list = members.filter(m => statusOf(m) === 'expiring')
      .sort((a, b) => daysLeft(a) - daysLeft(b));
    $('expiringTable').innerHTML = list.map(m => {
      const left = daysLeft(m);
      return `<tr>
        <td>${m.id}</td>
        <td>${escapeHtml(m.phone)}</td>
        <td title="${escapeHtml(m.device_id)}">${escapeHtml(maskDevice(m.device_id))}</td>
        <td>${fmtDate(m.end_time)}</td>
        <td><span class="badge expiring">${left} 天</span></td>
        <td><div class="row-actions">
          <button class="action-btn" data-act="renew" data-id="${m.id}">续费</button>
          <button class="action-btn" data-act="view" data-id="${m.id}">详情</button>
        </div></td>
      </tr>`;
    }).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:40px 0;">暂无即将到期会员</td></tr>`;

    $('expiringTable').querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        if (btn.dataset.act === 'renew') renewMember(id);
        else viewDetail(id);
      });
    });
  }

  // ========== 已停用会员 ==========
  function renderDisabled() {
    const list = members.filter(m => statusOf(m) === 'disabled');
    $('disabledTable').innerHTML = list.map(m => `<tr>
      <td>${m.id}</td>
      <td>${escapeHtml(m.phone)}</td>
      <td title="${escapeHtml(m.device_id)}">${escapeHtml(maskDevice(m.device_id))}</td>
      <td>${fmtDate(m.updated_at)}</td>
      <td>${escapeHtml(m.remark || '—')}</td>
      <td><div class="row-actions">
        <button class="action-btn" data-act="restore" data-id="${m.id}">恢复</button>
        <button class="action-btn" data-act="view" data-id="${m.id}">详情</button>
      </div></td>
    </tr>`).join('') || `<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:40px 0;">暂无已停用会员</td></tr>`;

    $('disabledTable').querySelectorAll('[data-act]').forEach(btn => {
      btn.addEventListener('click', () => {
        const id = parseInt(btn.dataset.id, 10);
        if (btn.dataset.act === 'restore') restoreMember(id);
        else viewDetail(id);
      });
    });
  }

  // ========== 操作日志 ==========
  function renderLogs() {
    $('logsTable').innerHTML = logs.map(l => `<tr>
      <td>${fmtDate(l.time)}</td>
      <td>${escapeHtml(l.admin)}</td>
      <td><span class="badge active" style="min-width:70px;text-align:center;">${escapeHtml(l.type)}</span></td>
      <td>${escapeHtml(l.target)}</td>
      <td>${escapeHtml(l.result)}</td>
    </tr>`).join('') || `<tr><td colspan="5" style="text-align:center;color:var(--text-muted);padding:40px 0;">暂无日志</td></tr>`;
  }

  // ========== 新增会员 ==========
  function openAddMember() {
    openModal(`
      <div class="modal-header">
        <div class="modal-title">新增会员</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="form-group">
          <label class="form-label">手机号 <span class="req">*</span></label>
          <input class="form-input" id="fPhone" placeholder="11 位手机号" maxlength="11" />
          <div class="form-error" id="ePhone"></div>
        </div>
        <div class="form-group">
          <label class="form-label">设备 ID <span class="req">*</span></label>
          <input class="form-input" id="fDevice" placeholder="设备唯一标识" maxlength="128" />
          <div class="form-hint">最长 128 字符，不能与现有会员重复</div>
          <div class="form-error" id="eDevice"></div>
        </div>
        <div class="form-group">
          <label class="form-label">会员天数 <span class="req">*</span></label>
          <input class="form-input" id="fDays" type="number" min="1" placeholder="例如 30" />
          <div class="form-error" id="eDays"></div>
        </div>
        <div class="form-group">
          <label class="form-label">备注</label>
          <input class="form-input" id="fRemark" placeholder="可选" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-primary" id="btnConfirmAdd">确认新增</button>
      </div>
    `);
    $('btnConfirmAdd').addEventListener('click', confirmAdd);
  }

  function confirmAdd() {
    const phone = $('fPhone').value.trim();
    const device = $('fDevice').value.trim();
    const days = parseInt($('fDays').value, 10);
    const remark = $('fRemark').value.trim();
    let ok = true;

    $('ePhone').classList.remove('show');
    $('eDevice').classList.remove('show');
    $('eDays').classList.remove('show');
    $('fPhone').classList.remove('error');
    $('fDevice').classList.remove('error');
    $('fDays').classList.remove('error');

    if (!PHONE_RE.test(phone)) {
      $('ePhone').textContent = '请输入正确的 11 位手机号';
      $('ePhone').classList.add('show');
      $('fPhone').classList.add('error');
      ok = false;
    } else if (members.some(m => m.phone === phone)) {
      $('ePhone').textContent = '该手机号已存在';
      $('ePhone').classList.add('show');
      $('fPhone').classList.add('error');
      ok = false;
    }
    if (!device) {
      $('eDevice').textContent = '请输入设备 ID';
      $('eDevice').classList.add('show');
      $('fDevice').classList.add('error');
      ok = false;
    } else if (device.length > 128) {
      $('eDevice').textContent = '设备 ID 不能超过 128 字符';
      $('eDevice').classList.add('show');
      $('fDevice').classList.add('error');
      ok = false;
    } else if (members.some(m => m.device_id.toLowerCase() === device.toLowerCase())) {
      $('eDevice').textContent = '该设备 ID 已存在';
      $('eDevice').classList.add('show');
      $('fDevice').classList.add('error');
      ok = false;
    }
    if (!days || days <= 0) {
      $('eDays').textContent = '请输入大于 0 的天数';
      $('eDays').classList.add('show');
      $('fDays').classList.add('error');
      ok = false;
    }
    if (!ok) return;

    const m = makeMember({ phone, device_id: device, days, remark });
    members.unshift(m);
    addLog('新增会员', phone, '成功 +' + days + '天');
    closeModal();
    toast('会员新增成功');
    render();
  }

  // ========== 查看详情 ==========
  function viewDetail(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    const s = statusOf(m);
    openModal(`
      <div class="modal-header">
        <div class="modal-title">会员详情</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="detail-list">
          <div class="k">内部 ID</div><div class="v">${m.id}</div>
          <div class="k">手机号</div><div class="v">${escapeHtml(m.phone)}</div>
          <div class="k">设备 ID</div><div class="v">${escapeHtml(m.device_id)}</div>
          <div class="k">会员状态</div><div class="v"><span class="badge ${s}">${statusLabel(s)}</span></div>
          <div class="k">开始时间</div><div class="v">${fmtDate(m.start_time)}</div>
          <div class="k">到期时间</div><div class="v">${fmtDate(m.end_time)}</div>
          <div class="k">剩余天数</div><div class="v">${daysLeft(m) >= 0 ? daysLeft(m) + ' 天' : '已过期'}</div>
          <div class="k">最近访问</div><div class="v">${fmtDate(m.last_seen)}</div>
          <div class="k">创建时间</div><div class="v">${fmtDate(m.created_at)}</div>
          <div class="k">备注</div><div class="v">${escapeHtml(m.remark || '—')}</div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">关闭</button>
      </div>
    `);
  }

  // ========== 续费 ==========
  function renewMember(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    const defaultDays = $('defaultDays') ? $('defaultDays').value : '30';
    openModal(`
      <div class="modal-header">
        <div class="modal-title">续费会员</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="confirm-text">会员：<strong>${escapeHtml(m.phone)}</strong>（ID: ${m.id}）</div>
        <div class="confirm-text" style="margin-bottom:16px;">当前到期：<strong>${fmtDate(m.end_time)}</strong></div>
        <div class="form-label">选择续费天数</div>
        <div class="days-grid" id="daysGrid">
          <div class="day-chip" data-days="30">30 天<span class="d">月卡</span></div>
          <div class="day-chip" data-days="90">90 天<span class="d">季卡</span></div>
          <div class="day-chip" data-days="180">180 天<span class="d">半年卡</span></div>
          <div class="day-chip" data-days="365">365 天<span class="d">年卡</span></div>
          <div class="day-chip" data-days="custom">自定义<span class="d">输入天数</span></div>
        </div>
        <div class="form-group" id="customDaysGroup" style="display:none;">
          <input class="form-input" id="fCustomDays" type="number" min="1" placeholder="请输入自定义天数" />
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-primary" id="btnConfirmRenew">确认续费</button>
      </div>
    `);
    let selectedDays = parseInt(defaultDays, 10) || 30;
    const grid = $('daysGrid');
    grid.querySelectorAll('.day-chip').forEach(c => {
      const d = c.dataset.days;
      if (d === String(selectedDays)) c.classList.add('selected');
      c.addEventListener('click', () => {
        grid.querySelectorAll('.day-chip').forEach(x => x.classList.remove('selected'));
        c.classList.add('selected');
        if (d === 'custom') {
          $('customDaysGroup').style.display = 'block';
        } else {
          $('customDaysGroup').style.display = 'none';
          selectedDays = parseInt(d, 10);
        }
      });
    });
    $('btnConfirmRenew').addEventListener('click', () => {
      const customChip = grid.querySelector('.day-chip.selected');
      if (customChip && customChip.dataset.days === 'custom') {
        const v = parseInt($('fCustomDays').value, 10);
        if (!v || v <= 0) { toast('请输入有效的自定义天数', 'error'); return; }
        selectedDays = v;
      }
      const base = Math.max(m.end_time, nowSec());
      m.end_time = base + selectedDays * DAY;
      if (m.vip === 0) { m.vip = 1; m.start_time = nowSec(); }
      m.updated_at = nowSec();
      addLog('续费', m.phone, '成功 +' + selectedDays + '天');
      closeModal();
      toast('续费成功，增加 ' + selectedDays + ' 天');
      render();
    });
  }

  // ========== 修改手机号 ==========
  function editPhone(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    openModal(`
      <div class="modal-header">
        <div class="modal-title">修改手机号</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="confirm-text" style="margin-bottom:14px;">当前手机号：<strong>${escapeHtml(m.phone)}</strong></div>
        <div class="form-group">
          <label class="form-label">新手机号 <span class="req">*</span></label>
          <input class="form-input" id="fNewPhone" maxlength="11" value="${escapeHtml(m.phone)}" />
          <div class="form-error" id="eNewPhone"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-primary" id="btnConfirmPhone">确认修改</button>
      </div>
    `);
    $('btnConfirmPhone').addEventListener('click', () => {
      const np = $('fNewPhone').value.trim();
      $('eNewPhone').classList.remove('show');
      $('fNewPhone').classList.remove('error');
      if (!PHONE_RE.test(np)) {
        $('eNewPhone').textContent = '请输入正确的 11 位手机号';
        $('eNewPhone').classList.add('show');
        $('fNewPhone').classList.add('error');
        return;
      }
      if (members.some(x => x.phone === np && x.id !== id)) {
        $('eNewPhone').textContent = '该手机号已被其他会员使用';
        $('eNewPhone').classList.add('show');
        $('fNewPhone').classList.add('error');
        return;
      }
      const old = m.phone;
      m.phone = np;
      m.updated_at = nowSec();
      addLog('修改手机号', old + ' → ' + np, '成功');
      closeModal();
      toast('手机号修改成功');
      render();
    });
  }

  // ========== 修改设备 ID ==========
  function editDevice(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    openModal(`
      <div class="modal-header">
        <div class="modal-title">修改设备 ID</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="confirm-text" style="margin-bottom:14px;">当前设备 ID：<strong>${escapeHtml(m.device_id)}</strong></div>
        <div class="form-group">
          <label class="form-label">新设备 ID <span class="req">*</span></label>
          <input class="form-input" id="fNewDevice" maxlength="128" value="${escapeHtml(m.device_id)}" />
          <div class="form-hint">最长 128 字符，不能与现有会员重复</div>
          <div class="form-error" id="eNewDevice"></div>
        </div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-primary" id="btnConfirmDevice">确认修改</button>
      </div>
    `);
    $('btnConfirmDevice').addEventListener('click', () => {
      const nd = $('fNewDevice').value.trim();
      $('eNewDevice').classList.remove('show');
      $('fNewDevice').classList.remove('error');
      if (!nd) {
        $('eNewDevice').textContent = '请输入设备 ID';
        $('eNewDevice').classList.add('show');
        $('fNewDevice').classList.add('error');
        return;
      }
      if (nd.length > 128) {
        $('eNewDevice').textContent = '设备 ID 不能超过 128 字符';
        $('eNewDevice').classList.add('show');
        $('fNewDevice').classList.add('error');
        return;
      }
      if (members.some(x => x.device_id.toLowerCase() === nd.toLowerCase() && x.id !== id)) {
        $('eNewDevice').textContent = '该设备 ID 已被其他会员使用';
        $('eNewDevice').classList.add('show');
        $('fNewDevice').classList.add('error');
        return;
      }
      m.device_id = nd;
      m.updated_at = nowSec();
      addLog('修改设备ID', m.phone, '成功');
      closeModal();
      toast('设备 ID 修改成功');
      render();
    });
  }

  // ========== 停用 / 恢复 ==========
  function disableMember(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    openModal(`
      <div class="modal-header">
        <div class="modal-title">停用会员</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="confirm-text">确定要停用会员 <strong>${escapeHtml(m.phone)}</strong>（ID: ${m.id}）吗？</div>
        <div class="confirm-text">停用后该会员将无法访问会员内容，可随时恢复。</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-danger" id="btnConfirmDisable">确认停用</button>
      </div>
    `);
    $('btnConfirmDisable').addEventListener('click', () => {
      m.vip = 0;
      m.updated_at = nowSec();
      addLog('停用会员', m.phone, '成功');
      closeModal();
      toast('会员已停用', 'warning');
      render();
    });
  }

  function restoreMember(id) {
    const m = members.find(x => x.id === id);
    if (!m) return;
    openModal(`
      <div class="modal-header">
        <div class="modal-title">恢复会员</div>
        <button class="modal-close" onclick="__admin.closeModal()">×</button>
      </div>
      <div class="modal-body">
        <div class="confirm-text">确定要恢复会员 <strong>${escapeHtml(m.phone)}</strong>（ID: ${m.id}）吗？</div>
        <div class="confirm-text">恢复后该会员状态为有效，如已过期将自动续期 30 天。</div>
      </div>
      <div class="modal-footer">
        <button class="btn btn-ghost" onclick="__admin.closeModal()">取消</button>
        <button class="btn btn-primary" id="btnConfirmRestore">确认恢复</button>
      </div>
    `);
    $('btnConfirmRestore').addEventListener('click', () => {
      m.vip = 1;
      const now = nowSec();
      if (m.end_time <= now) {
        m.start_time = now;
        m.end_time = now + 30 * DAY;
      }
      m.updated_at = now;
      addLog('恢复会员', m.phone, '成功');
      closeModal();
      toast('会员已恢复');
      render();
    });
  }

  // ========== 侧边栏（移动端） ==========
  function openSidebar() {
    $('sidebar').classList.add('open');
    $('sidebarMask').classList.add('show');
  }
  function closeSidebar() {
    $('sidebar').classList.remove('open');
    $('sidebarMask').classList.remove('show');
  }

  // ========== 事件绑定 ==========
  function bindEvents() {
    // 导航
    document.querySelectorAll('.nav-item').forEach(a => {
      a.addEventListener('click', () => showView(a.dataset.view));
    });
    // 移动端菜单
    $('menuToggle').addEventListener('click', openSidebar);
    $('sidebarMask').addEventListener('click', closeSidebar);
    // 弹窗关闭
    $('modalOverlay').addEventListener('click', (e) => {
      if (e.target.id === 'modalOverlay') closeModal();
    });
    // 新增会员
    $('btnAdd').addEventListener('click', openAddMember);
    // 搜索筛选：S2 暂不接服务端参数（S3 接入）；此处不改变页码、不发请求、也不对当前页做本地过滤
    $('searchPhone').addEventListener('input', (e) => { state.filters.phone = e.target.value; });
    $('searchDevice').addEventListener('input', (e) => { state.filters.device = e.target.value; });
    $('filterStatus').addEventListener('change', (e) => { state.filters.status = e.target.value; });
    $('filterExpire').addEventListener('change', (e) => { state.filters.expire = e.target.value; });
    $('btnResetFilter').addEventListener('click', () => {
      state.filters = { phone: '', device: '', status: '', expire: '' };
      $('searchPhone').value = '';
      $('searchDevice').value = '';
      $('filterStatus').value = '';
      $('filterExpire').value = '';
    });
    // 设置项开关
    document.querySelectorAll('.toggle').forEach(t => {
      t.addEventListener('click', () => {
        t.classList.toggle('on');
        const name = t.dataset.toggle;
        const on = t.classList.contains('on');
        toast((name === 'api' ? '后端 API 接入' : name === 'log' ? '操作审计日志' : '停用确认') + '已' + (on ? '开启' : '关闭'));
      });
    });
  }

  // 暴露给内联 onclick 使用
  window.__admin = { closeModal };

  // ========== 启动 ==========
  document.addEventListener('DOMContentLoaded', () => {
    bindEvents();
    render();
  });
})();

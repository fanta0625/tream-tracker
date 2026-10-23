const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const TZ = 'Asia/Shanghai';
const STATUS = {
  todo: '待开始',
  doing: '进行中',
  paused: '已搁置',
  blocked: '被阻塞',
  done: '已完成',
};
const PRIORITY = { high: '高', medium: '中', low: '低' };
const STATUS_COLOR = {
  todo: '#64748b',
  doing: '#2563eb',
  paused: '#d97706',
  blocked: '#dc2626',
  done: '#059669',
};

const state = {
  view: 'daily',
  date: todayStr(),
  user: null,
  members: [],
  day: null,
  items: [],
  summaryFrom: shiftDate(todayStr(), -6),
  summaryTo: todayStr(),
  projects: [],
  projectGroups: [],
  projectGroupFilter: '',
  reportType: 'daily',
  reportFrom: shiftDate(todayStr(), -29),
  reportTo: todayStr(),
  filters: { q: '', member_id: '', status: '' },
};

function todayStr() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const map = Object.fromEntries(parts.map((p) => [p.type, p.value]));
  return `${map.year}-${map.month}-${map.day}`;
}

function shiftDate(date, days) {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return dt.toISOString().slice(0, 10);
}

function diffDays(from, to) {
  if (!from || !to) return null;
  const [y1, m1, d1] = from.split('-').map(Number);
  const [y2, m2, d2] = to.split('-').map(Number);
  return Math.round((Date.UTC(y2, m2 - 1, d2) - Date.UTC(y1, m1 - 1, d1)) / 86400000);
}

function fmtDateCn(date, withYear = true) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    ...(withYear ? { year: 'numeric' } : {}),
    month: 'long',
    day: 'numeric',
    weekday: 'short',
  }).format(new Date(`${date}T12:00:00+08:00`)).replace(/(周[一二三四五六日])$/, ' $1');
}

function fmtTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function fmtDateTime(iso) {
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(new Date(iso));
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[c]));
}

function avatarStyle(name) {
  let h = 0;
  for (const ch of String(name)) h = (h * 31 + ch.codePointAt(0)) % 360;
  return `background:hsl(${h} 72% 90%);color:hsl(${h} 48% 32%)`;
}

function avatarText(name) {
  return String(name || '?').trim().slice(0, 1).toUpperCase();
}

function statusLabel(status) {
  return STATUS[status] || status;
}

function priorityLabel(priority) {
  return PRIORITY[priority] || priority;
}

function statusBadge(status) {
  return `<span class="badge ${esc(status)}">${esc(statusLabel(status))}</span>`;
}

function progressBar(progress, narrow = false) {
  const value = Math.max(0, Math.min(100, Number(progress) || 0));
  return `<div class="progress${narrow ? ' narrow' : ''}"><span style="width:${value}%"></span></div>`;
}

function daysBadge(days) {
  if (days === null || days === undefined) return '<span class="days none">未更新</span>';
  const d = Math.max(0, Number(days));
  if (d === 0) return '<span class="days ok">今天更新</span>';
  const cls = d > 7 ? 'warn' : d > 3 ? 'mid' : 'ok';
  return `<span class="days ${cls}">距上次 ${d} 天</span>`;
}

function memberOptions(selected, allLabel = '全部成员') {
  const options = [`<option value="">${allLabel}</option>`];
  for (const member of state.members) {
    options.push(
      `<option value="${member.id}" ${String(selected) === String(member.id) ? 'selected' : ''}>${esc(member.name)}${member.role ? ` · ${esc(member.role)}` : ''}</option>`
    );
  }
  return options.join('');
}

function statusOptions(selected) {
  return Object.entries(STATUS)
    .map(([key, label]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${label}</option>`)
    .join('');
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options,
  });
  const data = await response.json().catch(() => ({}));
  if (response.status === 401) {
    window.location.href = '/login';
    throw new Error('请先登录');
  }
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

function toast(message, type = 'ok') {
  const root = $('#toastRoot');
  const el = document.createElement('div');
  el.className = `toast ${type === 'error' ? 'error' : ''}`;
  el.textContent = message;
  root.appendChild(el);
  setTimeout(() => el.remove(), 3200);
}

async function loadMembers() {
  const { members } = await api('/api/members');
  state.members = members;
  const filter = $('#memberFilter');
  if (filter) filter.innerHTML = memberOptions(state.filters.member_id);
}

async function loadDaily() {
  $('#datePicker').value = state.date;
  $('#dateLabel').textContent = fmtDateCn(state.date);
  $('#exportMd').href = `/api/export/markdown?date=${state.date}`;
  $('#exportXlsx').href = `/api/export/xlsx?date=${state.date}`;
  $('#dailyList').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const data = await api(`/api/day?date=${state.date}`);
    state.day = data;
    renderSummary(data);
    renderDailyMembers(data);
  } catch (err) {
    $('#dailyList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderSummary(data) {
  const c = data.summary.statusCounts || {};
  const cards = [
    ['更新人数', `${data.summary.membersUpdated}<small>/${data.summary.members} 人</small>`, ''],
    ['更新记录', `${data.summary.updates}<small>条</small>`, ''],
    ['涉及事项', `${data.summary.itemsTouched}<small>项</small>`, ''],
    ['进行中', `${c.doing || 0}<small>项</small>`, 'doing'],
    ['搁置 / 阻塞', `${(c.paused || 0) + (c.blocked || 0)}<small>项</small>`, 'paused'],
    ['已完成', `${c.done || 0}<small>项</small>`, 'done'],
  ];
  $('#summaryCards').innerHTML = cards
    .map(([label, value, cls]) => `
      <div class="summary-card ${cls}">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`)
    .join('');
}

function renderDailyMembers(data) {
  if (!data.members.length) {
    $('#dailyList').innerHTML = `
      <div class="panel empty-state" style="grid-column:1/-1">
        还没有成员，先去「成员」页添加，或点右上角「新建事项」。
        <br><button class="btn primary" data-go-members>去添加成员</button>
      </div>`;
    return;
  }

  const sorted = [...data.members].sort((a, b) => {
    const au = a.updates.length > 0 ? 1 : 0;
    const bu = b.updates.length > 0 ? 1 : 0;
    return bu - au || b.active_count - a.active_count || a.name.localeCompare(b.name, 'zh');
  });

  $('#dailyList').innerHTML = sorted.map((member) => {
    const updates = member.updates.map((u) => `
      <div class="update">
        <div class="update-head">
          <button class="item-link" data-item="${u.item_id}">${esc(u.title)}</button>
          ${statusBadge(u.status)}
          <span class="progress-text">${u.progress}%</span>
        </div>
        ${progressBar(u.progress)}
        ${u.note ? `<p class="note">${esc(u.note)}</p>` : ''}
        <div class="update-foot">
          ${u.project ? `<span>${esc(u.project)}</span>` : ''}
          ${u.actor_name && u.actor_name !== member.name ? `<span>由 ${esc(u.actor_name)} 更新</span>` : ''}
          ${u.editor_name && u.editor_name !== u.actor_name ? `<span>编辑人 ${esc(u.editor_name)}</span>` : ''}
          <span>${fmtTime(u.created_at)}</span>
        </div>
        ${u.can_edit ? `<div class="update-actions">
          <button class="btn ghost" data-edit-update="${u.id}">编辑</button>
          <button class="btn danger ghost" data-delete-update="${u.id}">删除</button>
        </div>` : ''}
      </div>`).join('');

    const silent = member.silentItems || [];
    const silentHtml = silent.length ? `
      <div class="silent">
        <span>今日未更新 · ${silent.length} 项活跃事项</span>
        <div class="chips">
          ${silent.slice(0, 6).map((item) => `
            <button class="chip" data-item="${item.id}">
              <span class="dot" style="background:${STATUS_COLOR[item.status] || STATUS_COLOR.todo}"></span>${esc(item.title)}
            </button>`).join('')}
          ${silent.length > 6 ? `<span class="chip">+${silent.length - 6}</span>` : ''}
        </div>
      </div>` : '';

    return `
      <article class="member-card ${member.updates.length ? '' : 'empty'}">
        <div class="member-head">
          <div class="avatar" style="${avatarStyle(member.name)}">${esc(avatarText(member.name))}</div>
          <div>
            <h3>${esc(member.name)}${member.role ? `<span class="role">${esc(member.role)}</span>` : ''}</h3>
            <div class="member-meta">更新 ${member.updates.length} 条 · 活跃事项 ${member.active_count} 项</div>
          </div>
        </div>
        ${member.updates.length
          ? `<div class="updates">${updates}</div>`
          : '<div class="empty-state" style="padding:12px 0 4px">今日暂无更新</div>'}
        ${silentHtml}
      </article>`;
  }).join('');
}

async function loadItems() {
  const params = new URLSearchParams();
  if (state.filters.q) params.set('q', state.filters.q);
  if (state.filters.member_id) params.set('member_id', state.filters.member_id);
  if (state.filters.status) params.set('status', state.filters.status);

  $('#itemsTable').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const { items } = await api(`/api/items?${params.toString()}`);
    state.items = items;
    renderItems(items);
  } catch (err) {
    $('#itemsTable').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderItems(items) {
  $('#itemsCount').textContent = `${items.length} 项`;
  if (!items.length) {
    $('#itemsTable').innerHTML = '<div class="empty-state">没有符合条件的事项。</div>';
    return;
  }

  $('#itemsTable').innerHTML = `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>事项</th>
            <th>负责人</th>
            <th>状态</th>
            <th>进度</th>
            <th>最近更新</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          ${items.map((item) => `
            <tr>
              <td class="title-cell">
                <strong>${esc(item.title)}</strong>
                <span>${esc(item.project || '未归类')} · 优先级 ${esc(priorityLabel(item.priority))}</span>
              </td>
              <td>${esc(item.member_name)}<br><span class="muted">${esc(item.member_role || '')}</span></td>
              <td>${statusBadge(item.status)}</td>
              <td>
                <div style="min-width:110px">
                  ${progressBar(item.progress, true)}
                  <span class="muted" style="font-size:11px">${item.progress}%</span>
                </div>
              </td>
              <td>
                <div>${item.last_update_date ? esc(item.last_update_date) : '<span class="muted">暂无</span>'}</div>
                ${daysBadge(item.days_since_update)}
              </td>
              <td class="actions">
                <button class="btn ghost" data-open-item="${item.id}">${item.can_edit ? '更新 / 履历' : '查看履历'}</button>
              </td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}


async function loadSummary() {
  if (state.summaryFrom > state.summaryTo) {
    [state.summaryFrom, state.summaryTo] = [state.summaryTo, state.summaryFrom];
  }
  $('#summaryFrom').value = state.summaryFrom;
  $('#summaryTo').value = state.summaryTo;
  $('#summaryExportMd').href = `/api/export/markdown?from=${state.summaryFrom}&to=${state.summaryTo}`;
  $('#summaryExportXlsx').href = `/api/export/xlsx?from=${state.summaryFrom}&to=${state.summaryTo}`;
  $('#summaryMembers').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const data = await api(`/api/summary?from=${state.summaryFrom}&to=${state.summaryTo}`);
    renderSummaryPage(data);
  } catch (err) {
    $('#summaryMembers').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderSummaryPage(data) {
  const c = data.totals.statusCounts || {};
  const cards = [
    ['更新条数', `${data.totals.updates}<small>条</small>`, ''],
    ['参与人数', `${data.totals.membersUpdated}<small>/${data.totals.members} 人</small>`, ''],
    ['涉及事项', `${data.totals.itemsTouched}<small>项</small>`, ''],
    ['进行中', `${c.doing || 0}<small>项</small>`, 'doing'],
    ['搁置 / 阻塞', `${(c.paused || 0) + (c.blocked || 0)}<small>项</small>`, 'paused'],
    ['已完成', `${c.done || 0}<small>项</small>`, 'done'],
  ];
  $('#summaryPageCards').innerHTML = cards
    .map(([label, value, cls]) => `
      <div class="summary-card ${cls}">
        <div class="label">${label}</div>
        <div class="value">${value}</div>
      </div>`)
    .join('');

  if (!data.members.length) {
    $('#summaryMembers').innerHTML = '<div class="panel empty-state" style="grid-column:1/-1">还没有成员。</div>';
  } else {
    $('#summaryMembers').innerHTML = data.members.map((member) => `
      <article class="member-card summary-member ${member.updates ? '' : 'empty'}">
        <div class="member-head">
          <div class="avatar" style="${avatarStyle(member.name)}">${esc(avatarText(member.name))}</div>
          <div>
            <h3>${esc(member.name)}${member.role ? `<span class="role">${esc(member.role)}</span>` : ''}</h3>
            <div class="member-meta">${member.updates} 条更新 · ${member.items.length} 个事项${member.lastDate ? ` · 最近 ${esc(member.lastDate)}` : ''}</div>
          </div>
        </div>
        ${member.items.length ? `
          <div class="chips">
            ${member.items.slice(0, 10).map((item) => `
              <button class="chip" data-item="${item.id}">
                <span class="dot" style="background:${STATUS_COLOR[item.status] || STATUS_COLOR.todo}"></span>
                ${esc(item.title)} · ${statusLabel(item.status)} ${item.progress}%
              </button>`).join('')}
            ${member.items.length > 10 ? `<span class="chip">+${member.items.length - 10}</span>` : ''}
          </div>` : '<div class="empty-state" style="padding:8px 0">该时段无更新</div>'}
      </article>`).join('');
  }

  $('#summaryDays').innerHTML = data.days.length
    ? `<div class="section-title" style="margin:0 0 8px">每日更新</div>
       <div class="chips">
         ${data.days.map((day) => `<span class="chip">${esc(day.date.slice(5))} · ${day.updates} 条</span>`).join('')}
       </div>`
    : '<div class="muted">该时段暂无更新记录。</div>';
}

async function loadMembersView() {
  const [{ members }, { items }] = await Promise.all([api('/api/members'), api('/api/items')]);
  state.members = members;
  const activeByMember = new Map();
  for (const item of items) {
    if (item.status === 'done') continue;
    if (!activeByMember.has(item.member_id)) activeByMember.set(item.member_id, []);
    activeByMember.get(item.member_id).push(item);
  }

  $('#membersList').innerHTML = members.length
    ? members.map((member) => {
        const active = activeByMember.get(member.id) || [];
        return `
          <article class="member-card">
            <div class="member-head">
              <div class="avatar" style="${avatarStyle(member.name)}">${esc(avatarText(member.name))}</div>
              <div>
                <h3>${esc(member.name)}${member.role ? `<span class="role">${esc(member.role)}</span>` : ''}</h3>
                <div class="member-meta">${member.item_count} 个事项 · 活跃 ${member.active_count} 项 · 累计更新 ${member.update_count} 条</div>
              </div>
            </div>
            ${active.length ? `
              <div class="chips">
                ${active.slice(0, 8).map((item) => `
                  <button class="chip" data-item="${item.id}">
                    <span class="dot" style="background:${STATUS_COLOR[item.status] || STATUS_COLOR.todo}"></span>${esc(item.title)}
                  </button>`).join('')}
                ${active.length > 8 ? `<span class="chip">+${active.length - 8}</span>` : ''}
              </div>` : '<div class="empty-state" style="padding:10px 0">暂无活跃事项</div>'}
            <div style="margin-top:12px">
              <button class="btn ghost" data-filter-member="${member.id}">查看该成员事项</button>
            </div>
          </article>`;
      }).join('')
    : '<div class="panel empty-state" style="grid-column:1/-1">还没有成员，用上方表单添加第一位成员。</div>';
}

function switchView(view) {
  state.view = view;
  $$('.nav-btn').forEach((btn) => btn.classList.toggle('active', btn.dataset.view === view));
  $('#projectsView').hidden = view !== 'projects';
  $('#dailyView').hidden = view !== 'daily';
  $('#itemsView').hidden = view !== 'items';
  $('#summaryView').hidden = view !== 'summary';
  $('#groupsView').hidden = view !== 'groups';
  $('#membersView').hidden = view !== 'members';
}

async function setView(view) {
  switchView(view);
  if (view === 'projects') await loadProjects();
  if (view === 'daily') await loadDaily();
  if (view === 'items') await loadItems();
  if (view === 'summary') await loadSummary();
  if (view === 'groups') await loadGroups();
  if (view === 'members') await loadMembersView();
}

function openModal(html) {
  const root = $('#modalRoot');
  root.innerHTML = `<div class="modal-backdrop" data-close></div><div class="modal" role="dialog" aria-modal="true">${html}</div>`;
  root.classList.add('open');
  document.body.classList.add('modal-open');
  $$('[data-close]', root).forEach((el) => el.addEventListener('click', closeModal));
  const first = root.querySelector('input, select, textarea');
  if (first) setTimeout(() => first.focus(), 30);
}

function closeModal() {
  const root = $('#modalRoot');
  root.innerHTML = '';
  root.classList.remove('open');
  document.body.classList.remove('modal-open');
}

function timelineHtml(item) {
  if (!item.timeline.length) return '<div class="empty-state">暂无更新记录。</div>';
  return [...item.timeline].reverse().map((u) => {
    const gap = u.gap_days > 0 ? `<span class="gap">间隔 ${u.gap_days} 天</span>` : '';
    const transition = u.prev_status && u.prev_status !== u.status
      ? `${statusLabel(u.prev_status)} → ${statusLabel(u.status)}`
      : statusLabel(u.status);
    const delta = u.progress_delta !== null && u.progress_delta !== undefined && u.progress_delta !== 0
      ? `（${u.progress_delta > 0 ? '+' : ''}${u.progress_delta}%）`
      : '';
    return `
      <div class="tl-item">
        <div class="tl-dot ${esc(u.status)}"></div>
        <div class="tl-body">
          <div class="tl-head">
            <strong>${esc(u.update_date)}</strong>
            ${gap}
            ${statusBadge(u.status)}
          </div>
          <div class="tl-sub">${esc(transition)} · 进度 ${u.progress}%${delta}</div>
          ${u.note ? `<p>${esc(u.note)}</p>` : ''}
          <div class="tl-meta">${esc(u.actor_name || u.member_name)} · ${fmtDateTime(u.created_at)}${u.editor_name && u.editor_name !== u.actor_name ? ` · 编辑人 ${esc(u.editor_name)}` : ''}</div>
          ${u.can_edit ? `<div class="tl-actions">
            <button class="btn ghost" data-edit-update="${u.id}">编辑</button>
            <button class="btn danger ghost" data-delete-update="${u.id}">删除</button>
          </div>` : ''}
        </div>
      </div>`;
  }).join('');
}


async function openUpdateForm(updateId) {
  try {
    const data = await api(`/api/updates/${updateId}`);
    if (!data.can_edit) {
      toast('你没有权限修改该更新记录', 'error');
      return;
    }
    const { update, item } = data;
    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>编辑更新记录</h2>
          <div class="sub">${esc(item.title)} · ${esc(update.actor_name || item.member_name)}</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <form id="updateEditForm" class="form">
          <div class="meta-grid" style="margin:0">
            <label>日期
              <input type="date" name="update_date" value="${esc(update.update_date)}" required />
            </label>
            <label>状态
              <select name="status">${statusOptions(update.status)}</select>
            </label>
            <label>进度
              <input type="number" name="progress" min="0" max="100" value="${update.progress}" required />
            </label>
          </div>
          <label>更新内容
            <textarea name="note" rows="6" placeholder="今天做了什么、遇到什么、下一步…">${esc(update.note || '')}</textarea>
          </label>
          <button class="btn primary" type="submit">保存更新</button>
        </form>
      </div>`);

    $('#updateEditForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const body = Object.fromEntries(new FormData(form).entries());
      body.progress = Number(body.progress);
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        await api(`/api/updates/${updateId}`, { method: 'PATCH', body: JSON.stringify(body) });
        toast('更新已保存');
        closeModal();
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = '保存更新';
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openDeleteUpdateConfirm(updateId) {
  try {
    const data = await api(`/api/updates/${updateId}`);
    if (!data.can_edit) {
      toast('你没有权限删除该更新记录', 'error');
      return;
    }
    const { update, item } = data;
    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>删除更新记录</h2>
          <div class="sub">${esc(item.title)} · ${esc(update.update_date)}</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        ${update.note ? `<p class="description">${esc(update.note)}</p>` : ''}
        <p class="muted">删除后该条履历不可恢复；如果删除的是最新记录，事项状态和进度会自动回退到上一条。</p>
        <label class="form" style="margin-top:14px">输入「确认删除」后按钮才会启用
          <input id="deleteConfirmInput" autocomplete="off" placeholder="确认删除" style="border:1px solid var(--line);border-radius:10px;padding:9px 10px;font:inherit" />
        </label>
        <div style="display:flex;gap:10px;margin-top:16px">
          <button class="btn danger" id="deleteConfirmBtn" disabled>删除</button>
          <button class="btn ghost" data-close>取消</button>
        </div>
      </div>`);

    const input = $('#deleteConfirmInput');
    const button = $('#deleteConfirmBtn');
    input.addEventListener('input', () => {
      button.disabled = input.value.trim() !== '确认删除';
    });
    button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/updates/${updateId}`, { method: 'DELETE' });
        toast('更新记录已删除');
        closeModal();
        await refreshAll();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = input.value.trim() !== '确认删除';
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function openItem(id) {
  try {
    const { item } = await api(`/api/items/${id}`);
    const html = `
      <div class="modal-head">
        <div class="modal-title">
          <h2>${esc(item.title)}</h2>
          <div class="sub">
            ${esc(item.member_name)}${item.member_role ? ` · ${esc(item.member_role)}` : ''}
            ${item.project ? ` · ${esc(item.project)}` : ''}
          </div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body split">
        <section class="detail">
          <div class="detail-top">
            ${statusBadge(item.status)}
            ${daysBadge(item.days_since_update)}
            <span class="muted">优先级 ${esc(priorityLabel(item.priority))}</span>
          </div>
          <div class="progress-line">
            ${progressBar(item.progress)}
            <strong>${item.progress}%</strong>
          </div>
          <div class="meta-grid">
            <div><span>开始日期</span><strong>${esc(item.start_date || '-')}</strong></div>
            <div><span>计划完成</span><strong>${esc(item.due_date || '-')}</strong></div>
            <div><span>更新次数</span><strong>${item.update_count}</strong></div>
            <div><span>最近更新</span><strong>${esc(item.last_update_date || '-')}</strong></div>
            <div><span>创建人</span><strong>${esc(item.created_by_name || '-')}</strong></div>
            <div><span>最后更新人</span><strong>${esc(item.updated_by_name || '-')}</strong></div>
          </div>
          ${item.description ? `<p class="description">${esc(item.description)}</p>` : ''}
          <h3 class="section-title">更新履历</h3>
          <div class="timeline">${timelineHtml(item)}</div>
        </section>
        ${item.can_edit ? `
        <aside class="update-panel">
          <h3 class="section-title">记录更新</h3>
          <form id="updateForm" class="form">
            <label>日期
              <input type="date" name="update_date" value="${todayStr()}" required />
            </label>
            <label>状态
              <select name="status">${statusOptions(item.status)}</select>
            </label>
            <label>进度 <span class="hint">0 - 100</span>
              <input type="number" name="progress" min="0" max="100" value="${item.progress}" required />
            </label>
            <label>更新内容
              <textarea name="note" rows="6" placeholder="今天做了什么、遇到什么、下一步…"></textarea>
            </label>
            <button class="btn primary" type="submit">保存更新</button>
          </form>
          <button class="btn ghost" id="editItemBtn" style="width:100%;margin-top:16px">编辑事项信息</button>
          <button class="btn danger ghost" id="archiveBtn">归档事项</button>
        </aside>` : `
        <aside class="update-panel read-only">
          <h3 class="section-title">只读</h3>
          <p class="muted">只有事项负责人、组长或管理员可以更新该事项。</p>
        </aside>`}
      </div>`;

    openModal(html);

    const updateForm = $('#updateForm');
    if (updateForm) {
      updateForm.addEventListener('submit', async (event) => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button[type="submit"]');
        const data = Object.fromEntries(new FormData(form).entries());
        data.progress = Number(data.progress);
        button.disabled = true;
        button.textContent = '保存中…';
        try {
          await api(`/api/items/${item.id}/updates`, {
            method: 'POST',
            body: JSON.stringify(data),
          });
          toast('更新已记录');
          closeModal();
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
          button.disabled = false;
          button.textContent = '保存更新';
        }
      });
    }

    const editBtn = $('#editItemBtn');
    if (editBtn) editBtn.addEventListener('click', () => openEditItem(item));

    const archiveBtn = $('#archiveBtn');
    if (archiveBtn) {
      archiveBtn.addEventListener('click', async () => {
        if (!confirm(`确定归档「${item.title}」？归档后不再出现在列表，但数据保留。`)) return;
        try {
          await api(`/api/items/${item.id}`, { method: 'DELETE' });
          toast('事项已归档');
          closeModal();
          await refreshAll();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }
  } catch (err) {
    toast(err.message, 'error');
  }
}


function openEditItem(item) {
  const canTransfer = state.user.role === 'admin' || state.user.role === 'leader';
  const ownerField = canTransfer
    ? `<label>负责人
         <select name="member_id">${state.members.map((member) => `<option value="${member.id}" ${Number(member.id) === Number(item.member_id) ? 'selected' : ''}>${esc(member.name)}${member.role ? ` · ${esc(member.role)}` : ''}</option>`).join('')}</select>
       </label>`
    : `<label>负责人
         <input value="${esc(item.member_name)}" disabled />
       </label>`;

  openModal(`
    <div class="modal-head">
      <div class="modal-title">
        <h2>编辑事项信息</h2>
        <div class="sub">状态和进度请通过「记录更新」修改，以保留履历</div>
      </div>
      <button class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <form id="editItemForm" class="form">
        ${ownerField}
        <label>事项标题
          <input name="title" value="${esc(item.title)}" required />
        </label>
        <label>项目 / 模块
          <input name="project" value="${esc(item.project || '')}" />
        </label>
        <div class="meta-grid" style="margin:0">
          <label>优先级
            <select name="priority">
              <option value="high" ${item.priority === 'high' ? 'selected' : ''}>高</option>
              <option value="medium" ${item.priority === 'medium' ? 'selected' : ''}>中</option>
              <option value="low" ${item.priority === 'low' ? 'selected' : ''}>低</option>
            </select>
          </label>
          <label>开始日期
            <input type="date" name="start_date" value="${esc(item.start_date || '')}" />
          </label>
          <label>计划完成
            <input type="date" name="due_date" value="${esc(item.due_date || '')}" />
          </label>
        </div>
        <label>描述
          <textarea name="description" rows="4">${esc(item.description || '')}</textarea>
        </label>
        <button class="btn primary" type="submit">保存修改</button>
      </form>
    </div>`);

  $('#editItemForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    if (!canTransfer) delete data.member_id;
    if (data.member_id) data.member_id = Number(data.member_id);
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api(`/api/items/${item.id}`, {
        method: 'PATCH',
        body: JSON.stringify(data),
      });
      toast('事项信息已更新');
      closeModal();
      await refreshAll();
      await openItem(item.id);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = '保存修改';
    }
  });
}

function openNewItem() {
  if (state.user.role === 'member' && !state.user.member_id) {
    toast('当前账号未关联成员，请联系管理员', 'error');
    return;
  }
  if (!state.members.length) {
    toast('请先在「成员」页添加成员', 'error');
    setView('members');
    return;
  }
  const memberField = state.user.role === 'member'
    ? `<label>负责人
         <input value="${esc(state.user.member_name || '')}" disabled />
         <input type="hidden" name="member_id" value="${state.user.member_id}" />
       </label>`
    : `<label>负责人
         <select name="member_id" required>${memberOptions('', '请选择成员')}</select>
       </label>`;

  const html = `
    <div class="modal-head">
      <div class="modal-title">
        <h2>新建事项</h2>
        <div class="sub">创建后会自动生成第一条履历</div>
      </div>
      <button class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <form id="newItemForm" class="form">
        ${memberField}
        <label>事项标题
          <input name="title" placeholder="例如：支付回调重试" required />
        </label>
        <label>项目 / 模块
          <input name="project" placeholder="例如：支付平台" />
        </label>
        <div class="meta-grid" style="margin:0">
          <label>初始状态
            <select name="status">${statusOptions('todo')}</select>
          </label>
          <label>进度
            <input type="number" name="progress" min="0" max="100" value="0" />
          </label>
          <label>优先级
            <select name="priority">
              <option value="high">高</option>
              <option value="medium" selected>中</option>
              <option value="low">低</option>
            </select>
          </label>
          <label>开始日期
            <input type="date" name="start_date" value="${todayStr()}" />
          </label>
          <label>计划完成
            <input type="date" name="due_date" />
          </label>
        </div>
        <label>描述
          <textarea name="description" rows="3" placeholder="背景、目标、验收标准…"></textarea>
        </label>
        <label>第一条履历
          <textarea name="note" rows="3" placeholder="创建事项，计划怎么推进…"></textarea>
        </label>
        <button class="btn primary" type="submit">创建事项</button>
      </form>
    </div>`;

  openModal(html);

  $('#newItemForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    data.member_id = Number(data.member_id);
    data.progress = Number(data.progress);
    button.disabled = true;
    button.textContent = '创建中…';
    try {
      const { item } = await api('/api/items', { method: 'POST', body: JSON.stringify(data) });
      closeModal();
      toast('事项已创建');
      await loadMembers();
      await setView('items');
      await openItem(item.id);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = '创建事项';
    }
  });
}

function openExportRange() {
  const to = state.date;
  const from = shiftDate(to, -6);
  const html = `
    <div class="modal-head">
      <div class="modal-title">
        <h2>导出区间汇总</h2>
        <div class="sub">按日期范围汇总所有成员的更新记录</div>
      </div>
      <button class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <div class="meta-grid" style="grid-template-columns:repeat(2,minmax(0,1fr));margin-top:0">
        <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600;color:#4b5063">开始日期
          <input type="date" id="rangeFrom" value="${from}" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit" />
        </label>
        <label style="display:flex;flex-direction:column;gap:6px;font-size:12px;font-weight:600;color:#4b5063">结束日期
          <input type="date" id="rangeTo" value="${to}" style="border:1px solid var(--line);border-radius:10px;padding:8px 10px;font:inherit" />
        </label>
      </div>
      <div style="display:flex;gap:10px;margin-top:18px">
        <button class="btn primary" id="rangeMdBtn">导出 Markdown</button>
        <button class="btn ghost" id="rangeXlsxBtn">导出 Excel</button>
      </div>
      <p class="muted" style="margin:12px 0 0;font-size:12px">导出内容包含：日期、成员、事项、状态、进度、更新备注；Excel 另含事项总览和成员统计。</p>
    </div>`;
  openModal(html);

  const download = (format) => {
    const start = $('#rangeFrom').value;
    const end = $('#rangeTo').value;
    if (!start || !end) return toast('请选择开始和结束日期', 'error');
    if (start > end) return toast('开始日期不能晚于结束日期', 'error');
    window.location.href = `/api/export/${format}?from=${encodeURIComponent(start)}&to=${encodeURIComponent(end)}`;
  };
  $('#rangeMdBtn').addEventListener('click', () => download('markdown'));
  $('#rangeXlsxBtn').addEventListener('click', () => download('xlsx'));
}


function roleLabel(role) {
  return { admin: '管理员', leader: '组长', member: '成员' }[role] || role;
}

function applyUser() {
  if (!state.user) return;
  $('#userName').textContent = state.user.display_name || state.user.username;
  const role = $('#userRole');
  role.textContent = roleLabel(state.user.role);
  role.className = `role-pill ${state.user.role}`;
  $('#usersBtn').hidden = state.user.role !== 'admin';
  $('#mailBtn').hidden = state.user.role !== 'admin';
  const canCreateProject = state.user.role === 'admin'
    || (state.user.led_group_ids || []).length > 0;
  $('#newProjectBtn').hidden = !canCreateProject;
  $('#newGroupBtn').hidden = state.user.role !== 'admin';
  $('#memberForm').hidden = state.user.role !== 'admin';
}

function userStatusLabel(status) {
  return { pending: '待审核', active: '启用', disabled: '停用', rejected: '已拒绝' }[status] || status;
}

async function openUsers() {
  try {
    const [{ users }, { members }, { users: pending }, { groups }] = await Promise.all([
      api('/api/users'),
      api('/api/members'),
      api('/api/admin/registrations'),
      api('/api/groups'),
    ]);
    const linked = new Set(users.map((u) => u.member_id).filter(Boolean));
    const available = members.filter((m) => !linked.has(m.id));
    const memberOptionsForUser = available
      .map((m) => `<option value="${m.id}">${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ''}</option>`)
      .join('');
    const groupNames = new Map(groups.map((g) => [g.id, g.name]));

    const rows = users.map((u) => {
      const status = u.status || (u.active ? 'active' : 'disabled');
      const groupsText = (u.groups || []).map((g) => g.name).join('、') || '-';
      const canToggle = status === 'active' || status === 'disabled';
      return `
        <tr>
          <td>
            <strong>${esc(u.username)}</strong><br><span class="muted">${esc(u.display_name)}</span>
            <div style="margin-top:4px">
              <select data-user-member="${u.id}">
                <option value="">不关联成员</option>
                ${members.filter((m) => Number(m.id) === Number(u.member_id) || !linked.has(m.id)).map((m) => `<option value="${m.id}" ${Number(m.id) === Number(u.member_id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
              </select>
            </div>
          </td>
          <td><input class="user-email" data-user-email="${u.id}" value="${esc(u.email || '')}" placeholder="设置邮箱" /></td>
          <td>
            <select data-user-role="${u.id}">
              ${['admin', 'leader', 'member'].map((role) => `<option value="${role}" ${u.role === role ? 'selected' : ''}>${roleLabel(role)}</option>`).join('')}
            </select>
          </td>
          <td><span class="status-dot ${status === 'active' ? '' : 'off'}"></span>${userStatusLabel(status)}</td>
          <td>${esc(groupsText)}</td>
          <td class="actions">
            ${canToggle ? `<button class="btn ghost" data-user-toggle="${u.id}" data-status="${status}">${status === 'active' ? '停用' : '启用'}</button>` : ''}
            <button class="btn ghost" data-user-reset="${u.id}">重置密码</button>
          </td>
        </tr>`;
    }).join('');

    const pendingHtml = pending.length ? `
      <div class="pending-box">
        <div class="section-title" style="margin-top:0">待审核注册 · ${pending.length}</div>
        ${pending.map((u) => `
          <div class="pending-row">
            <div>
              <strong>${esc(u.display_name)}</strong>
              <span class="muted">${esc(u.email || u.username)} · ${fmtDateTime(u.created_at)}</span>
            </div>
            <div class="pending-actions">
              <button class="btn primary" data-approve-user="${u.id}">通过</button>
              <button class="btn danger ghost" data-reject-user="${u.id}">拒绝</button>
            </div>
          </div>`).join('')}
      </div>` : '';

    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>用户管理</h2>
          <div class="sub">审核注册、创建账号、分配角色；分组请到「分组」页操作</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        ${pendingHtml}
        <form class="user-create" id="createUserForm">
          <label>用户名
            <input name="username" placeholder="如 zhangsan" required />
          </label>
          <label>邮箱
            <input name="email" type="email" placeholder="可选，用于登录" />
          </label>
          <label>显示名
            <input name="display_name" placeholder="张三" />
          </label>
          <label>初始密码
            <input name="password" type="password" minlength="6" required />
          </label>
          <label>角色
            <select name="role">
              <option value="member">组员</option>
              <option value="leader">组长</option>
              <option value="admin">管理员</option>
            </select>
          </label>
          <label>关联成员
            <select name="member_id">
              <option value="">不关联</option>
              ${memberOptionsForUser}
            </select>
          </label>
          <div class="actions">
            <button class="btn primary" type="submit">创建账号</button>
          </div>
        </form>
        <div class="table-wrap">
          <table class="table user-table">
            <thead>
              <tr><th>账号</th><th>邮箱</th><th>角色</th><th>状态</th><th>组</th><th></th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="6" class="empty-state">暂无用户</td></tr>'}</tbody>
          </table>
        </div>
        <p class="muted" style="margin:12px 0 0;font-size:12px">分组和组长设置请到「分组」页；组长可以创建项目。</p>
      </div>`);

    $('#createUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.member_id) data.member_id = Number(data.member_id);
      else delete data.member_id;
      if (!data.email) delete data.email;
      button.disabled = true;
      button.textContent = '创建中…';
      try {
        await api('/api/users', { method: 'POST', body: JSON.stringify(data) });
        toast('账号已创建');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = '创建账号';
      }
    });

    $$('[data-approve-user]').forEach((button) => button.addEventListener('click', async () => {
      button.disabled = true;
      try {
        await api(`/api/admin/registrations/${button.dataset.approveUser}/approve`, {
          method: 'POST',
          body: JSON.stringify({ group_ids: [] }),
        });
        toast('已通过审核');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
      }
    }));

    $$('[data-reject-user]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('确定拒绝这条注册申请？')) return;
      try {
        await api(`/api/admin/registrations/${button.dataset.rejectUser}/reject`, { method: 'POST' });
        toast('已拒绝');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    }));

    $$('[data-user-reset]').forEach((button) => button.addEventListener('click', async () => {
      const password = prompt('输入新密码（至少 6 位）');
      if (!password) return;
      try {
        await api(`/api/users/${button.dataset.userReset}`, {
          method: 'PATCH',
          body: JSON.stringify({ password }),
        });
        toast('密码已重置');
      } catch (err) {
        toast(err.message, 'error');
      }
    }));

    $$('[data-user-toggle]').forEach((button) => button.addEventListener('click', async () => {
      const nextStatus = button.dataset.status === 'active' ? 'disabled' : 'active';
      try {
        await api(`/api/users/${button.dataset.userToggle}`, {
          method: 'PATCH',
          body: JSON.stringify({ status: nextStatus }),
        });
        toast(nextStatus === 'active' ? '账号已启用' : '账号已停用');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
      }
    }));

    $$('[data-user-email]').forEach((input) => input.addEventListener('change', async () => {
      try {
        await api(`/api/users/${input.dataset.userEmail}`, {
          method: 'PATCH',
          body: JSON.stringify({ email: input.value.trim() }),
        });
        toast('邮箱已更新');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
        await openUsers();
      }
    }));

    $$('[data-user-member]').forEach((select) => select.addEventListener('change', async () => {
      try {
        await api(`/api/users/${select.dataset.userMember}`, {
          method: 'PATCH',
          body: JSON.stringify({ member_id: select.value ? Number(select.value) : null }),
        });
        toast('关联成员已更新');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
        await openUsers();
      }
    }));

    $$('[data-user-role]').forEach((select) => select.addEventListener('change', async () => {
      try {
        await api(`/api/users/${select.dataset.userRole}`, {
          method: 'PATCH',
          body: JSON.stringify({ role: select.value }),
        });
        toast('角色已更新');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
        await openUsers();
      }
    }));
  } catch (err) {
    toast(err.message, 'error');
  }
}



function normalizeWeekStart(date) {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return shiftDate(date, -((day + 6) % 7));
}

function visibilityLabel(visibility) {
  return { private: '仅自己', group: '同组可见', public: '所有登录用户' }[visibility] || visibility;
}

function reportTypeLabel(type) {
  return type === 'weekly' ? '周报' : '日报';
}

function reportDateLabel(report) {
  if (report.type !== 'weekly') return report.report_date;
  const start = normalizeWeekStart(report.report_date);
  return `${start} ~ ${shiftDate(start, 6)}`;
}

async function loadProjects() {
  $('#projectsList').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const [{ projects }, { groups }] = await Promise.all([api('/api/projects'), api('/api/groups')]);
    state.projects = projects;
    state.projectGroups = groups;
    const filter = $('#projectGroupFilter');
    filter.innerHTML = '<option value="">全部组</option>' + groups.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join('');
    if (state.projectGroupFilter && !groups.some((g) => String(g.id) === String(state.projectGroupFilter))) {
      state.projectGroupFilter = '';
    }
    filter.value = state.projectGroupFilter;
    renderProjects();
  } catch (err) {
    $('#projectsList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderProjects() {
  const selected = state.projectGroupFilter;
  const projects = state.projects.filter((project) => !selected || String(project.group_id) === String(selected));
  if (!projects.length) {
    const message = state.user.role === 'member'
      ? '还没有可查看的项目，请联系组长创建项目。'
      : '还没有项目。点右上角「新建项目」开始。';
    $('#projectsList').innerHTML = `<div class="panel empty-state" style="grid-column:1/-1">${message}</div>`;
    return;
  }
  $('#projectsList').innerHTML = projects.map((project) => `
    <article class="member-card project-card">
      <div class="member-head">
        <div class="avatar" style="${avatarStyle(project.name)}">项</div>
        <div>
          <h3>${esc(project.name)}${project.can_manage ? '<span class="role">可管理</span>' : ''}</h3>
          <div class="member-meta">${esc(project.group_name)} · ${project.report_count} 份报告${project.last_report_date ? ` · 最近 ${esc(project.last_report_date)}` : ''}</div>
        </div>
      </div>
      <p class="project-desc">${esc(project.description || '暂无项目描述')}</p>
      <div class="project-foot">
        <button class="btn primary" data-open-project="${project.id}">进入项目</button>
      </div>
    </article>`).join('');
}

async function openProject(id, type = state.reportType || 'daily', from = state.reportFrom, to = state.reportTo) {
  try {
    state.reportType = type;
    state.reportFrom = from;
    state.reportTo = to;
    const [{ project }, data] = await Promise.all([
      api(`/api/projects/${id}`),
      api(`/api/projects/${id}/reports?type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);
    const reports = data.reports;
    const reportCards = reports.map((report) => {
      const sections = [
        [report.type === 'weekly' ? '本周完成' : '今日完成', report.done],
        ['进行中', report.doing],
        ['问题 / 风险', report.blockers],
        [report.type === 'weekly' ? '下周计划' : '明日计划', report.next_plan],
      ].filter(([, value]) => value);
      return `
        <article class="report-card">
          <div class="report-head">
            <div>
              <strong>${esc(report.author_name)}</strong>
              <span class="visibility-badge ${esc(report.visibility)}">${esc(visibilityLabel(report.visibility))}</span>
              <span class="badge ${report.type === 'weekly' ? 'doing' : 'todo'}">${reportTypeLabel(report.type)}</span>
            </div>
            <div class="report-head-right">
              <span class="muted">${esc(reportDateLabel(report))}</span>
              ${report.can_edit ? `<button class="btn ghost" data-edit-report="${report.id}">编辑</button><button class="btn danger ghost" data-delete-report="${report.id}">删除</button>` : ''}
            </div>
          </div>
          <div class="report-grid">
            ${sections.length ? sections.map(([label, value]) => `
              <div class="report-section">
                <span>${label}</span>
                <p>${esc(value)}</p>
              </div>`).join('') : '<p class="muted">暂无内容</p>'}
          </div>
          <div class="report-foot">更新于 ${fmtDateTime(report.updated_at)}</div>
        </article>`;
    }).join('');

    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>${esc(project.name)}</h2>
          <div class="sub">${esc(project.group_name)}${project.creator_name ? ` · 创建人 ${esc(project.creator_name)}` : ''}${project.description ? ` · ${esc(project.description)}` : ''}</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="project-actions">
          ${project.can_report ? `<button class="btn primary" data-write-report="daily">写日报</button><button class="btn primary" data-write-report="weekly">写周报</button>` : ''}
          ${project.can_manage ? `<button class="btn ghost" data-edit-project="${project.id}">编辑项目</button><button class="btn danger ghost" data-archive-project="${project.id}">归档项目</button>` : ''}
          <div class="toolbar-spacer"></div>
          <a class="btn ghost" href="/api/projects/${project.id}/reports/export?format=markdown&type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}">导出 Markdown</a>
          <a class="btn ghost" href="/api/projects/${project.id}/reports/export?format=xlsx&type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}">导出 Excel</a>
        </div>

        <div class="report-toolbar">
          <div class="report-tabs">
            <button class="tab-btn ${type === 'daily' ? 'active' : ''}" data-project-tab="daily">日报</button>
            <button class="tab-btn ${type === 'weekly' ? 'active' : ''}" data-project-tab="weekly">周报</button>
          </div>
          <input type="date" id="projectReportFrom" class="date-input" value="${esc(from)}" />
          <span class="muted">至</span>
          <input type="date" id="projectReportTo" class="date-input" value="${esc(to)}" />
          <button class="btn ghost" id="projectReportApply">筛选</button>
          <span class="muted">${reports.length} 份</span>
        </div>

        <div class="reports-list">${reportCards || '<div class="empty-state">该时间范围内还没有报告。</div>'}</div>
      </div>`);

    const reopen = (nextType = state.reportType) => {
      openProject(
        project.id,
        nextType,
        $('#projectReportFrom')?.value || state.reportFrom,
        $('#projectReportTo')?.value || state.reportTo
      );
    };

    $('#projectReportApply').addEventListener('click', () => reopen());
    $$('[data-project-tab]').forEach((button) => button.addEventListener('click', () => reopen(button.dataset.projectTab)));
    $$('[data-write-report]').forEach((button) => button.addEventListener('click', () => openReportForm(project, button.dataset.writeReport)));
    const editProjectBtn = $('[data-edit-project]');
    if (editProjectBtn) editProjectBtn.addEventListener('click', () => openProjectForm(project));

    const archiveProjectBtn = $('[data-archive-project]');
    if (archiveProjectBtn) {
      archiveProjectBtn.addEventListener('click', async () => {
        if (!confirm(`确定归档「${project.name}」？归档后不再出现在项目列表。`)) return;
        try {
          await api(`/api/projects/${project.id}`, { method: 'DELETE' });
          toast('项目已归档');
          closeModal();
          await loadProjects();
        } catch (err) {
          toast(err.message, 'error');
        }
      });
    }

    $$('[data-edit-report]').forEach((button) => button.addEventListener('click', () => {
      const report = reports.find((item) => Number(item.id) === Number(button.dataset.editReport));
      if (report) openReportForm(project, report.type, report);
    }));
    $$('[data-delete-report]').forEach((button) => button.addEventListener('click', async () => {
      if (!confirm('确定删除这份报告？')) return;
      try {
        await api(`/api/reports/${button.dataset.deleteReport}`, { method: 'DELETE' });
        toast('报告已删除');
        reopen();
      } catch (err) {
        toast(err.message, 'error');
      }
    }));
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openReportForm(project, type, report = null) {
  const isWeekly = type === 'weekly';
  const date = report?.report_date || (isWeekly ? normalizeWeekStart(todayStr()) : todayStr());
  const visibility = report?.visibility || 'group';
  openModal(`
    <div class="modal-head">
      <div class="modal-title">
        <h2>${report ? '编辑' : '写'}${reportTypeLabel(type)}</h2>
        <div class="sub">${esc(project.name)} · ${esc(project.group_name)}</div>
      </div>
      <button class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <form id="reportForm" class="form">
        <div class="meta-grid" style="margin:0">
          <label>${isWeekly ? '周起始日（周一）' : '日期'}
            <input type="date" name="report_date" value="${esc(date)}" required />
          </label>
          <label>可见性
            <select name="visibility">
              <option value="private" ${visibility === 'private' ? 'selected' : ''}>仅自己可见</option>
              <option value="group" ${visibility === 'group' ? 'selected' : ''}>同组可见</option>
              <option value="public" ${visibility === 'public' ? 'selected' : ''}>所有登录用户可见</option>
            </select>
          </label>
        </div>
        <label>${isWeekly ? '本周完成' : '今日完成'}
          <textarea name="done" rows="3" placeholder="${isWeekly ? '本周完成了什么' : '今天完成了什么'}">${esc(report?.done || '')}</textarea>
        </label>
        ${isWeekly ? '' : `<label>进行中
          <textarea name="doing" rows="2" placeholder="正在进行、还没完成的事">${esc(report?.doing || '')}</textarea>
        </label>`}
        <label>问题 / 风险
          <textarea name="blockers" rows="2" placeholder="阻塞、风险、需要支持">${esc(report?.blockers || '')}</textarea>
        </label>
        <label>${isWeekly ? '下周计划' : '明日计划'}
          <textarea name="next_plan" rows="3" placeholder="${isWeekly ? '下周准备做什么' : '明天准备做什么'}">${esc(report?.next_plan || '')}</textarea>
        </label>
        <button class="btn primary" type="submit">${report ? '保存修改' : '提交报告'}</button>
      </form>
    </div>`);

  $('#reportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (isWeekly) data.doing = '';
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      if (report) {
        await api(`/api/reports/${report.id}`, { method: 'PATCH', body: JSON.stringify(data) });
      } else {
        await api(`/api/projects/${project.id}/reports`, { method: 'POST', body: JSON.stringify(data) });
      }
      toast(report ? '报告已更新' : '报告已提交');
      closeModal();
      await openProject(project.id, type, state.reportFrom, state.reportTo);
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = report ? '保存修改' : '提交报告';
    }
  });
}

async function openProjectForm(project = null) {
  try {
    let groups = state.projectGroups;
    if (!groups.length) groups = (await api('/api/groups')).groups;
    const manageable = state.user.role === 'admin'
      ? groups
      : groups.filter((group) => Number(group.leader_user_id) === Number(state.user.id));
    if (!manageable.length) {
      toast('你还没有负责的组，请联系管理员', 'error');
      return;
    }
    const groupField = project
      ? `<label>所属组<input value="${esc(project.group_name)}" disabled /></label>`
      : `<label>所属组
           <select name="group_id" required>
             <option value="">请选择组</option>
             ${manageable.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join('')}
           </select>
         </label>`;
    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>${project ? '编辑项目' : '新建项目'}</h2>
          <div class="sub">项目归属于一个组，组员可以在项目下写日报/周报</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <form id="projectForm" class="form">
          ${groupField}
          <label>项目名称
            <input name="name" value="${esc(project?.name || '')}" required />
          </label>
          <label>项目描述
            <textarea name="description" rows="3" placeholder="目标、范围、说明">${esc(project?.description || '')}</textarea>
          </label>
          <button class="btn primary" type="submit">${project ? '保存修改' : '创建项目'}</button>
        </form>
      </div>`);

    $('#projectForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.group_id) data.group_id = Number(data.group_id);
      else delete data.group_id;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        let saved;
        if (project) {
          saved = (await api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(data) })).project;
        } else {
          saved = (await api('/api/projects', { method: 'POST', body: JSON.stringify(data) })).project;
        }
        toast(project ? '项目已更新' : '项目已创建');
        closeModal();
        await loadProjects();
        await openProject(saved.id, state.reportType, state.reportFrom, state.reportTo);
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = project ? '保存修改' : '创建项目';
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}


async function openPublicReports() {
  const to = todayStr();
  const from = shiftDate(to, -29);
  try {
    const { reports } = await api(`/api/reports/public?from=${from}&to=${to}`);
    const cards = reports.map((report) => {
      const sections = [
        [report.type === 'weekly' ? '本周完成' : '今日完成', report.done],
        ['进行中', report.doing],
        ['问题 / 风险', report.blockers],
        [report.type === 'weekly' ? '下周计划' : '明日计划', report.next_plan],
      ].filter(([, value]) => value);
      return `
        <article class="report-card">
          <div class="report-head">
            <div>
              <strong>${esc(report.author_name)}</strong>
              <span class="badge ${report.type === 'weekly' ? 'doing' : 'todo'}">${reportTypeLabel(report.type)}</span>
              <span class="visibility-badge public">${esc(visibilityLabel(report.visibility))}</span>
            </div>
            <div class="report-head-right">
              <span class="muted">${esc(report.project_name)} · ${esc(report.group_name)}</span>
              <span class="muted">${esc(reportDateLabel(report))}</span>
            </div>
          </div>
          <div class="report-grid">
            ${sections.length ? sections.map(([label, value]) => `
              <div class="report-section">
                <span>${label}</span>
                <p>${esc(value)}</p>
              </div>`).join('') : '<p class="muted">暂无内容</p>'}
          </div>
        </article>`;
    }).join('');

    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>公开报告</h2>
          <div class="sub">最近 30 天 · 所有登录用户可见的报告</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <div class="reports-list">${cards || '<div class="empty-state">最近 30 天没有公开报告。</div>'}</div>
      </div>`);
  } catch (err) {
    toast(err.message, 'error');
  }
}

async function loadGroups() {
  $('#groupsList').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const { groups } = await api('/api/groups');
    const users = state.user.role === 'admin' ? (await api('/api/users')).users : [];
    state.groups = groups;
    state.groupUsers = users;
    renderGroups(groups, users);
  } catch (err) {
    $('#groupsList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderGroups(groups, users) {
  const isAdmin = state.user.role === 'admin';
  $('#groupsList').innerHTML = groups.length ? groups.map((group) => {
    const memberIds = new Set(group.members.map((m) => m.id));
    const candidates = users.filter((u) => u.status === 'active' && !memberIds.has(u.id));
    return `
      <article class="member-card group-card">
        <div class="member-head">
          <div class="avatar" style="${avatarStyle(group.name)}">组</div>
          <div>
            <h3>${esc(group.name)}</h3>
            <div class="member-meta">${group.member_count} 人 · ${group.project_count || 0} 个项目${group.leader_name ? ` · 组长 ${esc(group.leader_name)}` : ' · 未指定组长'}</div>
          </div>
        </div>
        <div class="chips">
          ${group.members.length ? group.members.map((member) => `
            <span class="chip">
              ${esc(member.display_name || member.username)}${Number(member.id) === Number(group.leader_user_id) ? ' ★' : ''}
              ${isAdmin ? `<button class="chip-x" data-group-remove="${group.id}" data-user-id="${member.id}" title="移出组">×</button>` : ''}
            </span>`).join('') : '<span class="muted">暂无成员</span>'}
        </div>
        ${isAdmin ? `
          <div class="group-controls">
            <label>组长
              <select data-group-leader="${group.id}">
                <option value="">未指定</option>
                ${users.filter((u) => u.status === 'active').map((u) => `<option value="${u.id}" ${Number(u.id) === Number(group.leader_user_id) ? 'selected' : ''}>${esc(u.display_name || u.username)}</option>`).join('')}
              </select>
            </label>
            <label>添加成员
              <select data-group-add="${group.id}">
                <option value="">选择成员</option>
                ${candidates.map((u) => `<option value="${u.id}">${esc(u.display_name || u.username)}</option>`).join('')}
              </select>
            </label>
            <button class="btn ghost" data-group-rename="${group.id}">重命名</button>
          </div>` : ''}
      </article>`;
  }).join('') : '<div class="panel empty-state" style="grid-column:1/-1">还没有分组。管理员可以新建组、指定组长并添加成员。</div>';
}

async function openNewGroup() {
  try {
    const { users } = await api('/api/users');
    const active = users.filter((u) => u.status === 'active');
    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>新建组</h2>
          <div class="sub">一个用户可以属于多个组，一个用户可以担任多个组的组长</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <form id="newGroupForm" class="form">
          <label>组名
            <input name="name" placeholder="例如：后端组" required />
          </label>
          <label>组长
            <select name="leader_user_id">
              <option value="">暂不指定</option>
              ${active.map((u) => `<option value="${u.id}">${esc(u.display_name || u.username)}</option>`).join('')}
            </select>
          </label>
          <button class="btn primary" type="submit">创建</button>
        </form>
      </div>`);
    $('#newGroupForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.leader_user_id) data.leader_user_id = Number(data.leader_user_id);
      else delete data.leader_user_id;
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '创建中…';
      try {
        await api('/api/groups', { method: 'POST', body: JSON.stringify(data) });
        toast('组已创建');
        closeModal();
        await loadGroups();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = '创建';
      }
    });
  } catch (err) {
    toast(err.message, 'error');
  }
}

function openMailSettings() {
  api('/api/admin/mail').then(({ config }) => {
    const presets = {
      qq: { label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: 'ssl', hint: '密码填 QQ 邮箱授权码，不是登录密码' },
      '163': { label: '163 邮箱', host: 'smtp.163.com', port: 465, secure: 'ssl', hint: '密码填 163 邮箱授权码' },
      gmail: { label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: 'ssl', hint: '密码填 Google 应用专用密码' },
      custom: { label: '企业邮箱 / 自定义', host: config.host || '', port: config.port || 465, secure: config.secure || 'ssl', hint: '按企业邮箱管理员提供的 SMTP 信息填写' },
    };
    const presetKey = Object.entries(presets).find(([, p]) => p.host && p.host === config.host)?.[0] || 'custom';

    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>邮件设置</h2>
          <div class="sub">用于注册验证码和审核通知；密码加密保存，不会回传明文</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <form id="mailForm" class="form">
          <label>邮箱类型
            <select id="mailPreset">
              ${Object.entries(presets).map(([key, p]) => `<option value="${key}" ${key === presetKey ? 'selected' : ''}>${p.label}</option>`).join('')}
            </select>
          </label>
          <p class="muted" id="mailHint" style="margin:0;font-size:12px">${presets[presetKey].hint}</p>
          <div class="mail-grid">
            <label>SMTP Host
              <input name="host" value="${esc(config.host)}" placeholder="smtp.qq.com" required />
            </label>
            <label>端口
              <input name="port" type="number" value="${config.port || 465}" required />
            </label>
            <label>加密方式
              <select name="secure">
                <option value="ssl" ${config.secure === 'ssl' ? 'selected' : ''}>SSL（通常 465）</option>
                <option value="starttls" ${config.secure === 'starttls' ? 'selected' : ''}>STARTTLS（通常 587）</option>
                <option value="none" ${config.secure === 'none' ? 'selected' : ''}>不加密</option>
              </select>
            </label>
            <label>SMTP 账号
              <input name="user" value="${esc(config.user)}" placeholder="登录账号 / 完整邮箱" />
            </label>
            <label>密码 / 授权码
              <input name="password" type="password" placeholder="${config.hasPassword ? '已配置，留空不修改' : '请输入授权码'}" />
            </label>
            <label>发件人名称
              <input name="from_name" value="${esc(config.fromName)}" />
            </label>
            <label>发件邮箱
              <input name="from_email" type="email" value="${esc(config.fromEmail)}" placeholder="noreply@example.com" required />
            </label>
          </div>
          <label class="checkbox-line"><input type="checkbox" name="clear_password" /> 清除已保存的密码</label>
          <div style="display:flex;gap:10px;flex-wrap:wrap">
            <button class="btn primary" type="submit">保存配置</button>
            <button class="btn ghost" type="button" id="mailTestBtn">发送测试邮件</button>
            <input id="mailTestTo" type="email" value="${esc(state.user.email || config.fromEmail)}" placeholder="测试收件邮箱" style="flex:1;min-width:200px;border:1px solid var(--line);border-radius:10px;padding:8px 10px" />
          </div>
          <p class="muted" style="margin:0;font-size:12px">当前来源：${config.source === 'env' ? '环境变量（保存后将使用数据库配置）' : '数据库配置'}${config.hasPassword ? ' · 已保存密码' : ' · 未保存密码'}</p>
        </form>
      </div>`);

    const presetSelect = $('#mailPreset');
    presetSelect.addEventListener('change', () => {
      const preset = presets[presetSelect.value];
      $('#mailHint').textContent = preset.hint;
      if (preset.host) {
        $('input[name="host"]').value = preset.host;
        $('input[name="port"]').value = preset.port;
        $('select[name="secure"]').value = preset.secure;
      }
    });

    $('#mailForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = Object.fromEntries(new FormData(form).entries());
      data.port = Number(data.port);
      data.clear_password = Boolean(data.clear_password);
      const button = form.querySelector('button[type="submit"]');
      button.disabled = true;
      button.textContent = '保存中…';
      try {
        await api('/api/admin/mail', { method: 'PUT', body: JSON.stringify(data) });
        toast('邮件配置已保存');
        closeModal();
      } catch (err) {
        toast(err.message, 'error');
        button.disabled = false;
        button.textContent = '保存配置';
      }
    });

    $('#mailTestBtn').addEventListener('click', async () => {
      const to = $('#mailTestTo').value.trim();
      if (!to) return toast('请填写测试收件邮箱', 'error');
      const button = $('#mailTestBtn');
      button.disabled = true;
      button.textContent = '发送中…';
      try {
        await api('/api/admin/mail/test', { method: 'POST', body: JSON.stringify({ to }) });
        toast('测试邮件已发送');
      } catch (err) {
        toast(err.message, 'error');
      } finally {
        button.disabled = false;
        button.textContent = '发送测试邮件';
      }
    });
  }).catch((err) => toast(err.message, 'error'));
}

function openChangePassword() {
  openModal(`
    <div class="modal-head">
      <div class="modal-title">
        <h2>修改密码</h2>
        <div class="sub">${esc(state.user.display_name || state.user.username)}</div>
      </div>
      <button class="icon-btn" data-close aria-label="关闭">×</button>
    </div>
    <div class="modal-body">
      <form id="changePasswordForm" class="form">
        <label>原密码
          <input type="password" name="old_password" autocomplete="current-password" required />
        </label>
        <label>新密码
          <input type="password" name="new_password" minlength="6" autocomplete="new-password" required />
        </label>
        <label>确认新密码
          <input type="password" name="confirm_password" minlength="6" autocomplete="new-password" required />
        </label>
        <button class="btn primary" type="submit">保存</button>
      </form>
    </div>`);

  $('#changePasswordForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    if (data.new_password !== data.confirm_password) {
      toast('两次输入的新密码不一致', 'error');
      return;
    }
    const button = form.querySelector('button[type="submit"]');
    button.disabled = true;
    button.textContent = '保存中…';
    try {
      await api('/api/auth/password', {
        method: 'POST',
        body: JSON.stringify({
          old_password: data.old_password,
          new_password: data.new_password,
        }),
      });
      toast('密码已修改');
      closeModal();
    } catch (err) {
      toast(err.message, 'error');
      button.disabled = false;
      button.textContent = '保存';
    }
  });
}

async function refreshAll() {
  await loadMembers();
  if (state.view === 'projects') await loadProjects();
  else if (state.view === 'daily') await loadDaily();
  else if (state.view === 'items') await loadItems();
  else if (state.view === 'summary') await loadSummary();
  else if (state.view === 'groups') await loadGroups();
  else await loadMembersView();
}

function bindEvents() {
  $$('.nav-btn').forEach((btn) => btn.addEventListener('click', () => setView(btn.dataset.view)));

  $('#prevDay').addEventListener('click', () => {
    state.date = shiftDate(state.date, -1);
    loadDaily();
  });
  $('#nextDay').addEventListener('click', () => {
    state.date = shiftDate(state.date, 1);
    loadDaily();
  });
  $('#todayBtn').addEventListener('click', () => {
    state.date = todayStr();
    loadDaily();
  });
  $('#datePicker').addEventListener('change', (event) => {
    if (event.target.value) {
      state.date = event.target.value;
      loadDaily();
    }
  });

  $('#newItemBtn').addEventListener('click', openNewItem);
  $('#newProjectBtn').addEventListener('click', () => openProjectForm());
  $('#publicReportsBtn').addEventListener('click', openPublicReports);
  $('#projectGroupFilter').addEventListener('change', (event) => {
    state.projectGroupFilter = event.target.value;
    renderProjects();
  });
  $('#projectsList').addEventListener('click', (event) => {
    const button = event.target.closest('[data-open-project]');
    if (button) openProject(button.dataset.openProject);
  });
  $('#exportRangeBtn').addEventListener('click', openExportRange);
  $('#summaryApply').addEventListener('click', () => {
    state.summaryFrom = $('#summaryFrom').value || state.summaryFrom;
    state.summaryTo = $('#summaryTo').value || state.summaryTo;
    loadSummary();
  });
  $$('[data-summary-preset]').forEach((button) => button.addEventListener('click', () => {
    const today = todayStr();
    const preset = button.dataset.summaryPreset;
    if (preset === '7') state.summaryFrom = shiftDate(today, -6);
    else if (preset === '30') state.summaryFrom = shiftDate(today, -29);
    else state.summaryFrom = `${today.slice(0, 7)}-01`;
    state.summaryTo = today;
    loadSummary();
  }));
  $('#usersBtn').addEventListener('click', openUsers);
  $('#mailBtn').addEventListener('click', openMailSettings);
  $('#newGroupBtn').addEventListener('click', openNewGroup);

  $('#groupsList').addEventListener('change', async (event) => {
    const leaderSelect = event.target.closest('[data-group-leader]');
    if (leaderSelect) {
      try {
        await api(`/api/groups/${leaderSelect.dataset.groupLeader}`, {
          method: 'PATCH',
          body: JSON.stringify({ leader_user_id: leaderSelect.value ? Number(leaderSelect.value) : null }),
        });
        toast('组长已更新');
        await loadGroups();
      } catch (err) {
        toast(err.message, 'error');
        await loadGroups();
      }
      return;
    }
    const addSelect = event.target.closest('[data-group-add]');
    if (addSelect && addSelect.value) {
      try {
        await api(`/api/groups/${addSelect.dataset.groupAdd}/members`, {
          method: 'POST',
          body: JSON.stringify({ user_ids: [Number(addSelect.value)] }),
        });
        toast('成员已加入');
        await loadGroups();
      } catch (err) {
        toast(err.message, 'error');
        await loadGroups();
      }
    }
  });

  $('#groupsList').addEventListener('click', async (event) => {
    const rename = event.target.closest('[data-group-rename]');
    if (rename) {
      const name = prompt('新的组名');
      if (!name) return;
      try {
        await api(`/api/groups/${rename.dataset.groupRename}`, {
          method: 'PATCH',
          body: JSON.stringify({ name }),
        });
        toast('组名已更新');
        await loadGroups();
      } catch (err) {
        toast(err.message, 'error');
      }
      return;
    }
    const remove = event.target.closest('[data-group-remove]');
    if (remove) {
      if (!confirm('确定把该成员移出组？')) return;
      try {
        await api(`/api/groups/${remove.dataset.groupRemove}/members/${remove.dataset.userId}`, { method: 'DELETE' });
        toast('成员已移出');
        await loadGroups();
      } catch (err) {
        toast(err.message, 'error');
      }
    }
  });
  $('#changePasswordBtn').addEventListener('click', openChangePassword);
  $('#logoutBtn').addEventListener('click', async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } finally {
      window.location.href = '/login';
    }
  });

  $('#searchInput').addEventListener('input', (event) => {
    clearTimeout(globalThis.__searchTimer);
    globalThis.__searchTimer = setTimeout(() => {
      state.filters.q = event.target.value.trim();
      loadItems();
    }, 250);
  });
  $('#memberFilter').addEventListener('change', (event) => {
    state.filters.member_id = event.target.value;
    loadItems();
  });
  $('#statusFilter').addEventListener('change', (event) => {
    state.filters.status = event.target.value;
    loadItems();
  });
  $('#clearFilters').addEventListener('click', () => {
    state.filters = { q: '', member_id: '', status: '' };
    $('#searchInput').value = '';
    $('#memberFilter').value = '';
    $('#statusFilter').value = '';
    loadItems();
  });

  document.addEventListener('click', (event) => {
    const editUpdateBtn = event.target.closest('[data-edit-update]');
    if (editUpdateBtn) {
      openUpdateForm(editUpdateBtn.dataset.editUpdate);
      return;
    }
    const deleteUpdateBtn = event.target.closest('[data-delete-update]');
    if (deleteUpdateBtn) {
      openDeleteUpdateConfirm(deleteUpdateBtn.dataset.deleteUpdate);
      return;
    }
    const itemBtn = event.target.closest('[data-item]');
    if (itemBtn) {
      openItem(itemBtn.dataset.item);
      return;
    }
    const openBtn = event.target.closest('[data-open-item]');
    if (openBtn) {
      openItem(openBtn.dataset.openItem);
      return;
    }
    const memberFilterBtn = event.target.closest('[data-filter-member]');
    if (memberFilterBtn) {
      state.filters.member_id = memberFilterBtn.dataset.filterMember;
      state.filters.status = '';
      state.filters.q = '';
      $('#memberFilter').value = state.filters.member_id;
      $('#statusFilter').value = '';
      $('#searchInput').value = '';
      setView('items');
      return;
    }
    if (event.target.closest('[data-go-members]')) {
      setView('members');
    }
  });

  $('#memberForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const button = form.querySelector('button[type="submit"]');
    const data = Object.fromEntries(new FormData(form).entries());
    button.disabled = true;
    try {
      await api('/api/members', { method: 'POST', body: JSON.stringify(data) });
      form.reset();
      toast('成员已添加');
      await loadMembers();
      if (state.view === 'members') await loadMembersView();
      if (state.view === 'daily') await loadDaily();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      button.disabled = false;
    }
  });

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeModal();
  });
}

(async function init() {
  bindEvents();
  try {
    const { user } = await api('/api/auth/me');
    state.user = user;
    applyUser();
    await loadMembers();
    await loadDaily();
  } catch (err) {
    if (err.message !== '请先登录') {
      toast(err.message, 'error');
      $('#dailyList').innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    }
  }
})();

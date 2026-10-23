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
          <span>${fmtTime(u.created_at)}</span>
        </div>
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
  $('#dailyView').hidden = view !== 'daily';
  $('#itemsView').hidden = view !== 'items';
  $('#summaryView').hidden = view !== 'summary';
  $('#membersView').hidden = view !== 'members';
}

async function setView(view) {
  switchView(view);
  if (view === 'daily') await loadDaily();
  if (view === 'items') await loadItems();
  if (view === 'summary') await loadSummary();
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
          <div class="tl-meta">${esc(u.actor_name || u.member_name)} · ${fmtDateTime(u.created_at)}</div>
        </div>
      </div>`;
  }).join('');
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
          <p class="muted">只有事项负责人、主管或管理员可以更新该事项。</p>
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
          await openItem(item.id);
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
  const canTransfer = state.user.role === 'admin' || state.user.role === 'manager';
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
  return { admin: '管理员', manager: '主管', member: '成员' }[role] || role;
}

function applyUser() {
  if (!state.user) return;
  $('#userName').textContent = state.user.display_name || state.user.username;
  const role = $('#userRole');
  role.textContent = roleLabel(state.user.role);
  role.className = `role-pill ${state.user.role}`;
  $('#usersBtn').hidden = state.user.role !== 'admin';
  $('#memberForm').hidden = state.user.role !== 'admin';
}

async function openUsers() {
  try {
    const [{ users }, { members }] = await Promise.all([api('/api/users'), api('/api/members')]);
    const linked = new Set(users.map((u) => u.member_id).filter(Boolean));
    const available = members.filter((m) => !linked.has(m.id));
    const memberOptionsForUser = available
      .map((m) => `<option value="${m.id}">${esc(m.name)}${m.role ? ` · ${esc(m.role)}` : ''}</option>`)
      .join('');

    const rows = users.map((u) => `
      <tr>
        <td><strong>${esc(u.username)}</strong><br><span class="muted">${esc(u.display_name)}</span></td>
        <td>
          <select data-user-member="${u.id}">
            <option value="">不关联</option>
            ${members.filter((m) => Number(m.id) === Number(u.member_id) || !linked.has(m.id)).map((m) => `<option value="${m.id}" ${Number(m.id) === Number(u.member_id) ? 'selected' : ''}>${esc(m.name)}</option>`).join('')}
          </select>
        </td>
        <td>
          <select data-user-role="${u.id}">
            ${['admin', 'manager', 'member'].map((role) => `<option value="${role}" ${u.role === role ? 'selected' : ''}>${roleLabel(role)}</option>`).join('')}
          </select>
        </td>
        <td><span class="status-dot ${u.active ? '' : 'off'}"></span>${u.active ? '启用' : '停用'}</td>
        <td class="actions">
          <button class="btn ghost" data-user-reset="${u.id}">重置密码</button>
          <button class="btn ghost" data-user-toggle="${u.id}" data-active="${u.active}">${u.active ? '停用' : '启用'}</button>
        </td>
      </tr>`).join('');

    openModal(`
      <div class="modal-head">
        <div class="modal-title">
          <h2>用户管理</h2>
          <div class="sub">为团队成员创建账号，并关联到对应成员</div>
        </div>
        <button class="icon-btn" data-close aria-label="关闭">×</button>
      </div>
      <div class="modal-body">
        <form class="user-create" id="createUserForm">
          <label>用户名
            <input name="username" placeholder="如 zhangsan" required />
          </label>
          <label>显示名
            <input name="display_name" placeholder="张三" />
          </label>
          <label>初始密码
            <input name="password" type="password" minlength="6" required />
          </label>
          <label>角色
            <select name="role">
              <option value="member">成员</option>
              <option value="manager">主管</option>
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
              <tr><th>账号</th><th>关联成员</th><th>角色</th><th>状态</th><th></th></tr>
            </thead>
            <tbody>${rows || '<tr><td colspan="5" class="empty-state">暂无用户</td></tr>'}</tbody>
          </table>
        </div>
      </div>`);

    $('#createUserForm').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button[type="submit"]');
      const data = Object.fromEntries(new FormData(form).entries());
      if (data.member_id) data.member_id = Number(data.member_id);
      else delete data.member_id;
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
      try {
        await api(`/api/users/${button.dataset.userToggle}`, {
          method: 'PATCH',
          body: JSON.stringify({ active: button.dataset.active === '1' ? 0 : 1 }),
        });
        toast(button.dataset.active === '1' ? '账号已停用' : '账号已启用');
        await openUsers();
      } catch (err) {
        toast(err.message, 'error');
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
  if (state.view === 'daily') await loadDaily();
  else if (state.view === 'items') await loadItems();
  else if (state.view === 'summary') await loadSummary();
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

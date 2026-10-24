function bindCompletionProgress(form) {
  const status = form.elements.namedItem('status');
  const progress = form.elements.namedItem('progress');
  const sync = () => {
    const completed = status.value === 'done';
    if (completed) progress.value = '100';
    progress.readOnly = completed;
  };
  status.addEventListener('change', sync);
  sync();
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
        <form id="updateEditForm" class="form"><input type="hidden" name="version" value="${update.version}" />
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

    bindCompletionProgress($('#updateEditForm'));
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
        closeModal(true);
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
        closeModal(true);
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
      bindCompletionProgress(updateForm);
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
          closeModal(true);
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
          closeModal(true);
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
      <form id="editItemForm" class="form"><label>关联正式项目<select name="project_id" data-project-link><option value="">未关联（保留原始项目名称）</option></select></label><input type="hidden" name="version" value="${item.version}" data-current-project="${item.project_id || ''}" />
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
      closeModal(true);
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
      <form id="newItemForm" class="form"><label>关联正式项目<select name="project_id" data-project-link><option value="">未关联（保留原始项目名称）</option></select></label>
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

  bindCompletionProgress($('#newItemForm'));
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
      closeModal(true);
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


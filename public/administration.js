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
            <input name="password" type="password" minlength="12" maxlength="128" required />
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
      const password = prompt('输入新密码（12–128 位）');
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




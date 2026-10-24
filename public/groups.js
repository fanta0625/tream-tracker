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
        closeModal(true);
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
        closeModal(true);
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


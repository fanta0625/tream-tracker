async function loadProjects() {
  $('#projectsList').innerHTML = '<div class="empty-state">加载中…</div>';
  try {
    const [{ projects }, { groups }] = await Promise.all([api(`/api/projects?status=${state.projectStatus}`), api('/api/groups')]);
    state.projects = projects;
    state.projectGroups = groups;
    const filter = $('#projectGroupFilter');
    filter.innerHTML = '<option value="">全部组</option>' + groups.map((group) => `<option value="${group.id}">${esc(group.name)}</option>`).join('');
    if (state.projectGroupFilter && !groups.some((g) => String(g.id) === String(state.projectGroupFilter))) {
      state.projectGroupFilter = '';
    }
    filter.value = state.projectGroupFilter;
    if (!$('#projectStatusFilter')) {
      $('#projectGroupFilter').insertAdjacentHTML('afterend', '<select id="projectStatusFilter" aria-label="项目状态"><option value="active">进行中项目</option><option value="archived">归档项目</option></select>');
      $('#projectStatusFilter').onchange = event => { state.projectStatus = event.target.value; loadProjects(); };
    }
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

async function openProject(id, type = state.reportType || 'daily', from = state.reportFrom, to = state.reportTo, page = 1) {
  const requestId = ++requestVersions.project;
  try {
    state.reportType = type;
    state.reportFrom = from;
    state.reportTo = to;
    const [{ project }, data] = await Promise.all([
      api(`/api/projects/${id}`),
      api(`/api/projects/${id}/reports?page=${page}&limit=50&type=${encodeURIComponent(type)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`),
    ]);
    if (requestId !== requestVersions.project) return;
    const reports = data.reports;
    history.replaceState(null, '', `#project/${id}/${type}`);
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
              ${report.can_edit && project.status === 'active' ? `<button class="btn ghost" data-edit-report="${report.id}">编辑</button><button class="btn danger ghost" data-delete-report="${report.id}">删除</button>` : ''}
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
          ${project.can_manage ? `<button class="btn ghost" data-edit-project="${project.id}">编辑项目</button>${project.status === 'archived' ? `<button class="btn primary" id="restoreProject">恢复项目</button>` : `<button class="btn danger ghost" data-archive-project="${project.id}">归档项目</button>`}` : ''}
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

        <div class="reports-list">${reportCards || '<div class="empty-state">该时间范围内还没有报告。</div>'}</div><div class="actions"><button class="btn ghost" id="reportsPrev" ${page === 1 ? 'disabled' : ''}>上一页</button><span>第 ${page} 页</span><button class="btn ghost" id="reportsNext" ${data.has_more ? '' : 'disabled'}>下一页</button></div>
      </div>`);

    $('#reportsPrev').onclick = () => openProject(id, type, from, to, page - 1);
    $('#reportsNext').onclick = () => openProject(id, type, from, to, page + 1);
    if ($('#restoreProject')) $('#restoreProject').onclick = async () => {
      try { await api(`/api/projects/${id}`, { method: 'PATCH', body: JSON.stringify({ status: 'active', version: project.version }) }); await openProject(id); await loadProjects(); } catch (error) { toast(error.message, 'error'); }
    };
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
          closeModal(true);
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

  const draft = attachReportDraft($('#reportForm'), `${project.id}-${type}-${report?.id || 'new'}`);
  $('#reportForm').addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.currentTarget;
    const data = Object.fromEntries(new FormData(form).entries());
    data.type = type;
    if (report) data.version = report.version;
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
      await draft.clear();
      toast(report ? '报告已更新' : '报告已提交');
      closeModal(true);
      await openProject(project.id, type, data.report_date, data.report_date);
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
      if (project) data.version = project.version;
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
        closeModal(true);
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


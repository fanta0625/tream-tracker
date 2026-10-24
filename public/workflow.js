function attachReportDraft(form, key) {
  const url = `/api/drafts/${encodeURIComponent(key)}`;
  let timer, chain = Promise.resolve(), stopped = false, changed = false;
  const status = document.createElement('p');
  status.className = 'muted'; status.setAttribute('role', 'status');
  form.append(status);
  const snapshot = () => Object.fromEntries(new FormData(form));
  const save = () => {
    clearTimeout(timer);
    if (stopped) return chain;
    const content = snapshot();
    chain = chain.catch(() => {}).then(() => api(url, { method: 'PUT', body: JSON.stringify(content) }))
      .then(() => { status.textContent = '草稿已保存到当前账号（保留 30 天）'; })
      .catch(error => { status.textContent = `草稿保存失败：${error.message}`; throw error; });
    chain.catch(() => {});
    return chain;
  };
  api(url).then(({ draft }) => {
    if (!draft || changed || !form.isConnected) return;
    const button = document.createElement('button'); button.type = 'button'; button.className = 'btn ghost'; button.textContent = '恢复未提交草稿';
    button.onclick = () => { for (const [name, value] of Object.entries(draft)) { const input = form.elements.namedItem(name); if (input && name !== 'version') input.value = value; } window.modalDirty = true; changed = true; button.remove(); };
    form.prepend(button);
  }).catch(error => { status.textContent = error.message; });
  form.addEventListener('input', () => { changed = true; status.textContent = '草稿待保存…'; clearTimeout(timer); timer = setTimeout(save, 500); });
  return { async clear() { stopped = true; clearTimeout(timer); await chain.catch(() => {}); await api(url, { method: 'DELETE' }); } };
}

async function followLocation() {
  const [kind, id, type] = location.hash.slice(1).split('/');
  if (kind === 'project' && /^\d+$/.test(id)) { await setView('projects'); await openProject(id, type === 'weekly' ? 'weekly' : 'daily'); }
  else if (kind === 'view' && ['daily', 'items', 'summary', 'projects', 'members', 'groups'].includes(id)) await setView(id);
}
window.addEventListener('popstate', () => { if (!window.modalDirty) followLocation(); });
window.addEventListener('beforeunload', event => { if (window.modalDirty) { event.preventDefault(); event.returnValue = ''; } });
document.addEventListener('keydown', event => {
  if (event.key !== 'Tab') return;
  const modal = document.querySelector('#modalRoot.open');
  if (!modal) return;
  const elements = [...modal.querySelectorAll('button, a[href], input, textarea, select')].filter(el => !el.disabled && el.offsetParent !== null);
  if (!elements.length) return;
  const first = elements[0], last = elements.at(-1);
  if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
  else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
});

async function openAudit(before = '') {
  try {
    const { entries } = await api(`/api/admin/audit?limit=50&before=${before}`);
    openModal(`<div class="modal-head"><h2>操作审计</h2><button class="icon-btn" data-close aria-label="关闭">×</button></div><div class="modal-body">${entries.map(entry => `<details><summary>${esc(entry.created_at)} · ${esc(entry.action)} · ${esc(entry.entity)} #${entry.entity_id} · 用户 ${entry.actor_id || '系统'}</summary><pre style="white-space:pre-wrap;overflow-wrap:anywhere">${esc(JSON.stringify({ before: entry.before_json ? JSON.parse(entry.before_json) : null, after: entry.after_json ? JSON.parse(entry.after_json) : null }, null, 2))}</pre></details>`).join('') || '<p>暂无操作记录</p>'}<button class="btn ghost" id="olderAudit" ${entries.length < 50 ? 'disabled' : ''}>更早记录</button></div>`);
    $('#olderAudit').onclick = () => openAudit(entries.at(-1).id);
  } catch (error) { toast(error.message, 'error'); }
}

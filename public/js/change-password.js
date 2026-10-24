const form = document.querySelector('#passwordForm');
const errorBox = document.querySelector('#passwordError');
form.addEventListener('submit', async event => {
  event.preventDefault();
  errorBox.hidden = true;
  const button = form.querySelector('[type="submit"]');
  const data = Object.fromEntries(new FormData(form));
  button.disabled = true;
  try {
    if (data.new_password !== data.confirm_password) throw new Error('两次输入的新密码不一致');
    const response = await fetch('/api/auth/password', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ old_password: data.old_password, new_password: data.new_password }),
    });
    const result = await response.json();
    if (response.status === 401) { window.location.href = '/login'; return; }
    if (!response.ok) throw new Error(result.error || '修改失败');
    window.location.href = '/';
  } catch (error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  } finally { button.disabled = false; }
});
document.querySelector('#logout').addEventListener('click', async () => {
  const response = await fetch('/api/auth/logout', { method: 'POST' });
  if (response.ok) window.location.href = '/login';
});

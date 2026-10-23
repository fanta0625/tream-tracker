const form = document.querySelector('#loginForm');
const errorBox = document.querySelector('#loginError');
const button = form.querySelector('button[type="submit"]');

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  errorBox.hidden = true;
  button.disabled = true;
  button.textContent = '登录中…';

  const data = Object.fromEntries(new FormData(form).entries());
  try {
    const response = await fetch('/api/auth/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || '登录失败');
    window.location.href = '/';
  } catch (err) {
    errorBox.textContent = err.message;
    errorBox.hidden = false;
    button.disabled = false;
    button.textContent = '登录';
  }
});

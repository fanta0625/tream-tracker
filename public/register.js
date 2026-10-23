const form = document.querySelector('#registerForm');
const errorBox = document.querySelector('#registerError');
const successBox = document.querySelector('#registerSuccess');
const submitButton = form.querySelector('button[type="submit"]');
const sendButton = document.querySelector('#sendCodeBtn');
const emailInput = form.querySelector('input[name="email"]');
let countdownTimer = null;

function showError(message) {
  successBox.hidden = true;
  errorBox.textContent = message;
  errorBox.hidden = false;
}

function showSuccess(message) {
  errorBox.hidden = true;
  successBox.textContent = message;
  successBox.hidden = false;
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`);
  return data;
}

sendButton.addEventListener('click', async () => {
  const email = emailInput.value.trim();
  if (!email) {
    showError('请先填写邮箱');
    emailInput.focus();
    return;
  }
  sendButton.disabled = true;
  try {
    await postJson('/api/auth/register/send-code', { email });
    showSuccess('验证码已发送，请检查邮箱（包括垃圾邮件）');
    let seconds = 60;
    sendButton.textContent = `${seconds}s 后重发`;
    countdownTimer = setInterval(() => {
      seconds -= 1;
      if (seconds <= 0) {
        clearInterval(countdownTimer);
        sendButton.disabled = false;
        sendButton.textContent = '重新发送';
      } else {
        sendButton.textContent = `${seconds}s 后重发`;
      }
    }, 1000);
  } catch (err) {
    showError(err.message);
    sendButton.disabled = false;
  }
});

form.addEventListener('submit', async (event) => {
  event.preventDefault();
  const data = Object.fromEntries(new FormData(form).entries());
  if (data.password !== data.confirm_password) {
    showError('两次输入的密码不一致');
    return;
  }
  submitButton.disabled = true;
  submitButton.textContent = '提交中…';
  try {
    const result = await postJson('/api/auth/register', {
      email: data.email,
      code: data.code,
      password: data.password,
      display_name: data.display_name,
    });
    form.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
    showSuccess(result.message || '注册成功，等待管理员审核');
  } catch (err) {
    showError(err.message);
    submitButton.disabled = false;
    submitButton.textContent = '提交注册';
  }
});

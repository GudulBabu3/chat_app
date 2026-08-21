const form = document.getElementById('login-form');
const usernameInput = document.getElementById('username');
const passwordInput = document.getElementById('password');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/';
    } else {
      errorEl.textContent = data.error || 'Login failed.';
    }
  } catch (err) {
    errorEl.textContent = 'Could not reach the server. Try again.';
  } finally {
    submitBtn.disabled = false;
  }
});

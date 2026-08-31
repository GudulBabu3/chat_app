const form = document.getElementById('login-form');
const passwordInput = document.getElementById('password');
const errorEl = document.getElementById('login-error');

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  const password = passwordInput.value;
  if (!password) return;

  const submitBtn = form.querySelector('button[type="submit"]');
  submitBtn.disabled = true;
  try {
    const res = await fetch('/admin/api/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ password }),
    });
    const data = await res.json();
    if (data.ok) {
      window.location.href = '/admin';
    } else {
      errorEl.textContent = data.error || 'Login failed.';
      passwordInput.value = '';
      passwordInput.focus();
    }
  } catch (err) {
    errorEl.textContent = 'Could not reach the server. Try again.';
  } finally {
    submitBtn.disabled = false;
  }
});

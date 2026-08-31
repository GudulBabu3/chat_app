// Admin panel client - talks to the /admin/api/* routes added in server.js.
// No native confirm()/alert() dialogs anywhere (bad UX, block the whole
// tab) - "dangerous" actions use a two-click arm/confirm pattern instead.

const toastEl = document.getElementById('toast');
let toastTimer = null;

function toast(message, kind = 'ok') {
  toastEl.textContent = message;
  toastEl.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toastEl.className = 'toast hidden';
  }, 4000);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    method: options.method || 'GET',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  let data;
  try {
    data = await res.json();
  } catch {
    data = { ok: false, error: `Unexpected response (${res.status}).` };
  }
  if (res.status === 401) {
    window.location.href = '/admin/login';
    throw new Error('Not authenticated.');
  }
  if (!data.ok) throw new Error(data.error || `Request failed (${res.status}).`);
  return data;
}

function fmtDate(iso) {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10);
}

function renderTagList(field, items) {
  const ul = document.getElementById(`${field}-list`);
  ul.innerHTML = '';
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'tag-empty';
    li.textContent = '(none yet)';
    ul.appendChild(li);
    return;
  }
  items.forEach((text) => {
    const li = document.createElement('li');
    li.className = 'tag';
    const span = document.createElement('span');
    span.textContent = text;
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tag-remove';
    btn.textContent = '×';
    btn.title = `Remove "${text}"`;
    btn.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        await api(`/admin/api/list/${field}/remove`, { method: 'POST', body: { text } });
        toast(`Removed from ${field}s.`);
        await loadStatus();
      } catch (err) {
        toast(err.message, 'error');
        btn.disabled = false;
      }
    });
    li.appendChild(span);
    li.appendChild(btn);
    ul.appendChild(li);
  });
}

function describeArc(arc) {
  if (!arc) return '—';
  if (arc.phase === 'resting') {
    const due = arc.nextArcDueAt ? `next arc due ${fmtDate(arc.nextArcDueAt)}` : 'next arc not scheduled yet';
    return `Resting (${due}). Completed cycles: ${arc.cycleCount}.`;
  }
  const started = arc.phaseStartedAt ? fmtDate(arc.phaseStartedAt) : '?';
  return `Phase: ${arc.phase} (started ${started}, target ${arc.phaseTargetDays} day(s)). Completed cycles: ${arc.cycleCount}.`;
}

let latestStatus = null;

async function loadStatus() {
  const data = await api('/admin/api/status');
  latestStatus = data;

  document.getElementById('pet-name').textContent = `${data.petName} admin panel`;
  document.getElementById('status-line').textContent =
    `${data.userCount} user${data.userCount === 1 ? '' : 's'} · push ${data.pushEnabled ? 'on' : 'OFF'}`;

  renderTagList('skill', data.extraSkills);
  renderTagList('like', data.extraLikes);
  renderTagList('dislike', data.extraDislikes);

  document.getElementById('special-current').textContent = data.todaySpecial || '(nothing set for today)';
  document.getElementById('arc-current').textContent = describeArc(data.arc);

  const stickerSelect = document.getElementById('send-sticker');
  if (!stickerSelect.dataset.populated) {
    stickerSelect.innerHTML = data.allowedStickers
      .map((s) => `<option value="${s}"${s === data.defaultSticker ? ' selected' : ''}>${s}</option>`)
      .join('');
    stickerSelect.dataset.populated = '1';
  }
}

async function loadUsers() {
  const data = await api('/admin/api/users');
  const listEl = document.getElementById('users-list');
  const datalist = document.getElementById('user-list');
  datalist.innerHTML = data.users.map((u) => `<option value="${u.username}"></option>`).join('');

  listEl.innerHTML = '';
  if (!data.users.length) {
    listEl.textContent = 'No users yet.';
    return;
  }
  data.users.forEach((u) => {
    const row = document.createElement('div');
    row.className = 'user-row';

    const info = document.createElement('span');
    info.className = 'username';
    info.textContent = u.username;

    const joined = document.createElement('span');
    joined.className = 'joined';
    joined.textContent = u.createdAt ? `joined ${fmtDate(u.createdAt)}` : '';

    const delBtn = document.createElement('button');
    delBtn.type = 'button';
    delBtn.className = 'confirm-btn danger row-delete-btn';
    delBtn.textContent = 'Delete';
    wireConfirmButton(
      delBtn,
      async () => {
        await api('/admin/api/users/delete', { method: 'POST', body: { username: u.username } });
        toast(`Deleted "${u.username}".`);
        await refreshAll();
      },
      'Confirm delete?'
    );

    row.appendChild(info);
    row.appendChild(joined);
    row.appendChild(delBtn);
    listEl.appendChild(row);
  });
}

function refreshAll() {
  return Promise.all([loadStatus(), loadUsers()]).catch((err) => toast(err.message, 'error'));
}

// --- Send message ---
document.getElementById('send-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const username = document.getElementById('send-username').value.trim();
  const message = document.getElementById('send-message').value.trim();
  const sticker = document.getElementById('send-sticker').value;
  if (!username || !message) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    await api('/admin/api/send', { method: 'POST', body: { username, message, sticker } });
    toast(`Sent to ${username}.`);
    document.getElementById('send-message').value = '';
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// --- Create / update user ---
document.getElementById('create-user-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const usernameInput = document.getElementById('new-username');
  const passwordInput = document.getElementById('new-password');
  const username = usernameInput.value.trim();
  const password = passwordInput.value;
  if (!username || !password) return;

  const btn = e.target.querySelector('button[type="submit"]');
  btn.disabled = true;
  try {
    const data = await api('/admin/api/users/create', { method: 'POST', body: { username, password } });
    toast(data.message || 'Saved.');
    usernameInput.value = '';
    passwordInput.value = '';
    await loadUsers();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    btn.disabled = false;
  }
});

// --- Persona extras: add forms ---
document.querySelectorAll('.add-form').forEach((form) => {
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const field = form.dataset.field;
    const input = form.querySelector('input');
    const text = input.value.trim();
    if (!text) return;
    const btn = form.querySelector('button');
    btn.disabled = true;
    try {
      await api(`/admin/api/list/${field}/add`, { method: 'POST', body: { text } });
      toast(`Added to ${field}s.`);
      input.value = '';
      await loadStatus();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
});

// --- Today's special ---
document.getElementById('special-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('special-text');
  const text = input.value.trim();
  if (!text) return;
  try {
    await api('/admin/api/special', { method: 'POST', body: { action: 'set', text } });
    toast("Today's special set.");
    input.value = '';
    await loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

document.getElementById('special-clear-btn').addEventListener('click', async () => {
  try {
    await api('/admin/api/special', { method: 'POST', body: { action: 'clear' } });
    toast("Today's special cleared.");
    await loadStatus();
  } catch (err) {
    toast(err.message, 'error');
  }
});

// Reusable two-click arm/confirm pattern for a "dangerous" button - no
// native confirm()/alert() dialogs (they block the whole tab). First click
// arms it (relabels + highlights, auto-disarms after 4s); second click
// within that window runs onConfirm().
function wireConfirmButton(btn, onConfirm, confirmLabel = 'Click again to confirm') {
  const originalLabel = btn.textContent;
  let armed = false;
  let armTimer = null;

  btn.addEventListener('click', async () => {
    if (!armed) {
      armed = true;
      btn.classList.add('armed');
      btn.textContent = confirmLabel;
      armTimer = setTimeout(() => {
        armed = false;
        btn.classList.remove('armed');
        btn.textContent = originalLabel;
      }, 4000);
      return;
    }
    clearTimeout(armTimer);
    armed = false;
    btn.classList.remove('armed');
    btn.textContent = originalLabel;
    btn.disabled = true;
    try {
      await onConfirm();
    } catch (err) {
      toast(err.message, 'error');
    } finally {
      btn.disabled = false;
    }
  });
}

// --- Story arc: two-click arm/confirm, no native dialogs ---
document.querySelectorAll('.confirm-btn[data-action]').forEach((btn) => {
  wireConfirmButton(btn, async () => {
    await api(`/admin/api/arc/${btn.dataset.action}`, { method: 'POST' });
    toast('Story arc updated.');
    await loadStatus();
  });
});

// --- Logout ---
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/admin/api/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/admin/login';
});

refreshAll();

// Handles the "notify me when TukuruMukuru checks in" button in chat.html.
// Loaded before client.js; exposes nothing global, just wires up #notify-btn.
//
// Note for iOS: Safari only allows Web Push for a PWA that's been added to
// the home screen (iOS 16.4+) - it will not work for a page open in a
// regular Safari tab. The button below still works there once installed.

(function () {
  const btn = document.getElementById('notify-btn');
  if (!btn) return;

  const supported =
    'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
  if (!supported) return; // leave the button hidden

  function urlBase64ToUint8Array(base64String) {
    const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const rawData = window.atob(base64);
    return Uint8Array.from([...rawData].map((c) => c.charCodeAt(0)));
  }

  async function getVapidPublicKey() {
    const res = await fetch('/api/push/vapid-public-key');
    if (!res.ok) throw new Error('Could not fetch VAPID key');
    const { key } = await res.json();
    return key;
  }

  async function currentSubscription() {
    const reg = await navigator.serviceWorker.ready;
    return reg.pushManager.getSubscription();
  }

  function setButtonState(subscribed) {
    btn.classList.toggle('active', subscribed);
    btn.title = subscribed
      ? "You'll get notified when TukuruMukuru checks in"
      : 'Get notified when TukuruMukuru checks in';
  }

  async function subscribe() {
    const permission = await Notification.requestPermission();
    if (permission !== 'granted') return;

    const reg = await navigator.serviceWorker.ready;
    const key = await getVapidPublicKey();
    const subscription = await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(key),
    });

    await fetch('/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(subscription),
    });
    setButtonState(true);
  }

  async function unsubscribe() {
    const sub = await currentSubscription();
    if (sub) {
      await fetch('/api/push/unsubscribe', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint: sub.endpoint }),
      });
      await sub.unsubscribe();
    }
    setButtonState(false);
  }

  btn.addEventListener('click', async () => {
    btn.disabled = true;
    try {
      const sub = await currentSubscription();
      if (sub) {
        await unsubscribe();
      } else {
        await subscribe();
      }
    } catch (err) {
      console.warn('[push] toggle failed', err);
    } finally {
      btn.disabled = false;
    }
  });

  navigator.serviceWorker.ready
    .then(() => currentSubscription())
    .then((sub) => {
      btn.classList.remove('hidden');
      setButtonState(!!sub);
    })
    .catch(() => {});
})();

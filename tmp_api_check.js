const base = 'http://127.0.0.1:3000';

async function request(path, token, maxBody = null) {
  const headers = token ? { Authorization: `Bearer ${token}` } : {};
  const res = await fetch(`${base}${path}`, { headers });
  const text = await res.text();
  const outBody = maxBody == null ? text : text.slice(0, maxBody);
  console.log(`${path} -> status ${res.status}`);
  console.log(`body: ${outBody}`);
  if (maxBody != null) console.log(`body_length: ${text.length}`);
}

(async () => {
  const email = process.env.TM_TEST_EMAIL;
  const password = process.env.TM_TEST_PASSWORD;
  let token = null;

  if (email && password) {
    const loginRes = await fetch(`${base}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password })
    });
    const loginText = await loginRes.text();
    console.log(`/api/auth/login -> status ${loginRes.status}`);
    console.log(`body: ${loginText}`);
    if (loginRes.ok) {
      try { token = JSON.parse(loginText).token || null; } catch {}
    }
    console.log(`token_obtenido: ${token ? 'si' : 'no'}`);
    await request('/api/tickets/my-tickets', token);
    await request('/api/tickets/purchased-events', token);
  } else {
    console.log('TM_TEST_EMAIL/TM_TEST_PASSWORD no definidas; omitiendo login.');
    await request('/api/tickets/my-tickets');
    await request('/api/tickets/purchased-events');
  }

  await request('/api/events', null, 400);
})().catch(err => {
  console.error('script_error:', err.message || err);
  process.exit(1);
});

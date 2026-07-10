// ─────────────────────────────────────────────────────────────
// Supabase connection + shared team login gate.
// The URL and publishable key below are meant to be public —
// Supabase's security model relies on Row Level Security in the
// database (see schema.sql), not on hiding this key.
// ─────────────────────────────────────────────────────────────

const SUPABASE_URL = 'https://fkodscfxyqvapwacvlzq.supabase.co';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_JuSX9c8qtvIP32WRv88oww_GY8MlfwC';

// The whole team logs in as this one account. Nobody needs to know
// the email — the login screen only ever asks for the password.
const SHARED_LOGIN_EMAIL = 'will@georgedavisinc.com';

const sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);

function buildLoginOverlay(onSuccess) {
  const overlay = document.createElement('div');
  overlay.id = 'auth-gate-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;background:#0f1923;display:flex;align-items:center;justify-content:center;z-index:999;font-family:Inter,-apple-system,BlinkMacSystemFont,sans-serif;';
  overlay.innerHTML = `
    <div style="background:#fff;border-radius:6px;padding:32px 36px;width:340px;max-width:90vw;box-shadow:0 10px 40px rgba(0,0,0,0.3);">
      <div style="font-family:Georgia,serif;font-size:19px;margin-bottom:4px;color:#0f1923;">Deal Workspace</div>
      <div style="font-size:11px;color:#7a8a99;text-transform:uppercase;letter-spacing:0.08em;margin-bottom:20px;">Team access required</div>
      <div style="margin-bottom:14px;">
        <label style="display:block;font-size:10px;text-transform:uppercase;letter-spacing:0.07em;color:#7a8a99;margin-bottom:5px;">Team Password</label>
        <input type="password" id="auth-gate-password" style="width:100%;box-sizing:border-box;border:1px solid #d8dfe6;border-radius:4px;padding:9px 10px;font-size:13px;font-family:inherit;" />
      </div>
      <div id="auth-gate-error" style="color:#c0392b;font-size:12px;margin-bottom:10px;display:none;"></div>
      <button id="auth-gate-submit" style="width:100%;background:#0052cc;color:white;border:none;border-radius:4px;padding:10px;font-size:13px;cursor:pointer;font-family:inherit;">Unlock</button>
    </div>
  `;
  document.body.appendChild(overlay);
  document.getElementById('auth-gate-password').focus();

  const submit = async () => {
    const pw = document.getElementById('auth-gate-password').value;
    const btn = document.getElementById('auth-gate-submit');
    const errEl = document.getElementById('auth-gate-error');
    errEl.style.display = 'none';
    btn.textContent = 'Checking…';
    btn.disabled = true;
    const { error } = await sb.auth.signInWithPassword({ email: SHARED_LOGIN_EMAIL, password: pw });
    btn.textContent = 'Unlock';
    btn.disabled = false;
    if (error) {
      errEl.textContent = 'Wrong password — try again.';
      errEl.style.display = 'block';
      return;
    }
    overlay.remove();
    onSuccess();
  };

  document.getElementById('auth-gate-submit').onclick = submit;
  document.getElementById('auth-gate-password').addEventListener('keydown', e => { if (e.key === 'Enter') submit(); });
}

// Call this before rendering anything on a page. Resolves once a
// valid session exists — either one already saved in the browser,
// or after the team password is entered successfully.
function requireAuth() {
  return new Promise(async (resolve) => {
    const { data: { session } } = await sb.auth.getSession();
    if (session) { resolve(); return; }
    buildLoginOverlay(resolve);
  });
}

function logout() {
  sb.auth.signOut().then(() => location.reload());
}

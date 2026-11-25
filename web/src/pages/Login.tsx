import { useState } from 'preact/hooks';
import { api } from '../api/client';

interface Props {
  onSuccess: () => void;
}

export function Login({ onSuccess }: Props) {
  const [pw, setPw] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e: Event) => {
    e.preventDefault();
    setErr('');
    setBusy(true);
    try {
      await api.login(pw);
      onSuccess();
    } catch (ex: any) {
      setErr(ex.message || '登录失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="auth-wrap">
      <div class="card auth-card">
        <div style={{ textAlign: 'center', marginBottom: '24px' }}>
          <img src="/logo.png" alt="LFNL Logo" class="logo-light" style={{ height: '26px', width: 'auto', margin: '0 auto 14px' }} />
          <img src="/logo-dark.png" alt="LFNL Logo" class="logo-dark" style={{ height: '26px', width: 'auto', margin: '0 auto 14px' }} />
          <div class="eyebrow" style={{ justifyContent: 'center' }}>ACCESS CONTROL</div>
          <h2 style={{ fontSize: '20px', fontWeight: 700, marginTop: '4px' }}>S3控制系统</h2>
        </div>

        {err && <div class="alert alert-err" style={{ marginBottom: '14px' }}>{err}</div>}

        <form onSubmit={submit}>
          <div class="field">
            <label>管理员密码</label>
            <input
              class="input"
              type="password"
              value={pw}
              onInput={(e) => setPw((e.target as HTMLInputElement).value)}
              placeholder="请输入管理员密码"
              autoFocus
              required
            />
          </div>
          <button class="btn btn-primary" style={{ width: '100%', padding: '10px' }} disabled={busy}>
            {busy ? '验证中...' : '登录系统'}
          </button>
        </form>
      </div>
    </div>
  );
}

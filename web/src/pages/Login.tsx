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
    <div class="container">
      <div class="card auth-box">
        <div class="card-title">SSP32S3 管理登录</div>
        {err && <div class="alert alert-err">{err}</div>}
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
          <button class="btn btn-primary" style={{ width: '100%' }} disabled={busy}>
            {busy ? '验证中...' : '登录'}
          </button>
        </form>
      </div>
    </div>
  );
}

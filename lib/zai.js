// chat.z.ai auth protocol client.
// Endpoints confirmed against the live service:
//   POST /api/v1/auths/signup        {name, email, password, profile_image_url, sso_redirect, captcha_verify_param?}
//   POST /api/v1/auths/verify_email  {username, email, token}
//   POST /api/v1/auths/finish_signup {username, email, token, password, profile_image_url, sso_redirect}
//   POST /api/v1/auths/signin        {email, password, captcha_verify_param?}
//   POST /api/v1/auths/resend_email  {name, email, sso_redirect}

import { Transport } from './http.js';

export const BASE = 'https://chat.z.ai';
const API = `${BASE}/api/v1`;

export const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

export class ZaiClient {
  constructor({ proxy = null, timeout = 30000, insecure = false, onRetry = null } = {}) {
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  _headers(extra = {}) {
    return {
      'Content-Type': 'application/json',
      Accept: 'application/json',
      Origin: BASE,
      Referer: `${BASE}/auth`,
      'User-Agent': UA,
      'Accept-Language': 'en-US,en;q=0.9',
      ...extra,
    };
  }

  async _post(path, payload) {
    const res = await this.t.json(`${API}${path}`, {
      method: 'POST',
      headers: this._headers(),
      body: JSON.stringify(payload),
    });
    return res;
  }

  signup({ name, email, password, captchaParam = null }) {
    const body = {
      name,
      email,
      password,
      profile_image_url: '',
      sso_redirect: `${BASE}/`,
    };
    if (captchaParam) body.captcha_verify_param = captchaParam;
    return this._post('/auths/signup', body);
  }

  verifyEmail({ username, email, token }) {
    return this._post('/auths/verify_email', { username, email, token });
  }

  finishSignup({ username, email, token, password }) {
    return this._post('/auths/finish_signup', {
      username,
      email,
      token,
      password,
      profile_image_url: '',
      sso_redirect: `${BASE}/`,
    });
  }

  signin({ email, password, captchaParam = null }) {
    const body = { email, password };
    if (captchaParam) body.captcha_verify_param = captchaParam;
    return this._post('/auths/signin', body);
  }

  resendEmail({ name, email }) {
    return this._post('/auths/resend_email', { name, email, sso_redirect: `${BASE}/` });
  }

  // Public config endpoint, used for connectivity self-test.
  config() {
    return this.t.json(`${BASE}/api/config`, { headers: this._headers() });
  }
}

// Pull the JWT out of any of the known response shapes.
export function extractJwt(data) {
  if (!data || typeof data !== 'object') return '';
  if (data.user && typeof data.user.token === 'string' && data.user.token) return data.user.token;
  if (typeof data.token === 'string' && data.token) return data.token;
  if (data.user && typeof data.user.access_token === 'string' && data.user.access_token) return data.user.access_token;
  return '';
}

// Turn a failed response into a structured classification.
export function classifyFailure(res) {
  const status = res?.status ?? 0;
  const text = typeof res?.text === 'string' ? res.text : JSON.stringify(res?.data ?? '');
  const detail =
    (res?.data && (res.data.detail || res.data.message || res.data.error)) || text || 'no body';
  const raw = `${text} ${JSON.stringify(res?.data ?? '')}`;

  if (status === 405) return { kind: 'waf_block', message: 'Aliyun WAF blocked signup from this IP (405) — wait 10–30 min or use a different IP/proxy' };
  if (/EMAIL_DOMAIN_BLOCKED/i.test(raw)) return { kind: 'domain_blocked', message: raw.slice(0, 200) };
  if (status === 429) return { kind: 'rate_limit', message: String(detail) };
  if (/captcha/i.test(String(detail))) return { kind: 'captcha', message: String(detail) };
  if (/already|exist|registered|taken/i.test(String(detail))) return { kind: 'email_taken', message: String(detail) };
  if (status >= 500) return { kind: 'server', message: `HTTP ${status}: ${String(detail).slice(0, 200)}` };
  if (status >= 400) return { kind: 'rejected', message: `HTTP ${status}: ${String(detail).slice(0, 200)}` };
  return { kind: 'unknown', message: String(detail).slice(0, 200) };
}

// Read-only z.ai API helpers used by zai-regger's status, limits and HTTP console.
// Chat itself goes through the browser: raw /api/chat/completions requests are
// rejected without the frontend's signature + captcha context (see README).

import { Transport } from './http.js';
import { BASE, UA } from './zai.js';

export function makeTransport(config = {}) {
  return new Transport({
    proxy: config.proxy || null,
    timeout: 30000,
    insecure: false,
  });
}

export async function api(config, account, { method = 'GET', path = '/', body = null, headers = {}, fullUrl = null } = {}) {
  if (!account || !account.token) throw new Error('select an account with a JWT first (/switch)');
  const t = makeTransport(config);
  const url = fullUrl || (path.startsWith('http') ? path : `${BASE}${path.startsWith('/') ? '' : '/'}${path}`);
  const reqHeaders = {
    Authorization: `Bearer ${account.token}`,
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'User-Agent': UA,
    Origin: BASE,
    Referer: `${BASE}/`,
    ...headers,
  };
  const res = await t.json(url, {
    method,
    headers: reqHeaders,
    body: body == null ? null : typeof body === 'string' ? body : JSON.stringify(body),
    retries: 0,
    timeout: 45000,
  });
  return res;
}

export function decodeModels(payload) {
  const rows = payload?.data || payload?.models || [];
  return rows.map((m) => {
    const info = m.info || {};
    const meta = info.meta || {};
    const extra = meta.info || {};
    let efforts = Array.isArray(extra.thinking_effort_level)
      ? extra.thinking_effort_level
      : Array.isArray(meta.thinking_effort_level)
        ? meta.thinking_effort_level
        : [];
    if (m.id === 'glm-5.2' && (!efforts || !efforts.length)) {
      efforts = ['low', 'high', 'max'];
    }
    return {
      id: m.id,
      name: m.name || info.name || m.id,
      efforts,
      maxTokens: info.params?.max_tokens ?? m.max_tokens ?? null,
      description: meta.description || extra.desc?.en || '',
    };
  });
}

export async function getModels(config, account) {
  const res = await api(config, account, { path: '/api/models' });
  if (res.status >= 400) throw new Error(`GET /api/models → HTTP ${res.status}`);
  const models = decodeModels(res.data);
  if (!models.length) throw new Error('GET /api/models returned no models');
  return models;
}

export async function getProfile(config, account) {
  const res = await api(config, account, { path: '/api/v1/auths/' });
  if (res.status >= 400) throw new Error(`GET /api/v1/auths/ → HTTP ${res.status}`);
  return res.data;
}

export async function getLimits(config, account) {
  const [sub, cfg, quota] = await Promise.all([
    api(config, account, { path: '/api/v1/users/user/subscription' }),
    api(config, account, { path: '/api/config' }),
    api(config, account, { path: '/api/v1/dashboard/feature-quota/summary' }),
  ]);
  if (sub.status >= 400) throw new Error(`GET subscription → HTTP ${sub.status}`);
  const data = sub.data?.data || sub.data || {};
  const plan = data.selectedPlan || {};
  const quotaData = quota.status === 200 ? quota.data?.data || {} : {};
  return {
    level: plan.level || 'unknown',
    planId: plan.planId || plan.planType || '—',
    source: data.source || '—',
    expiresAt: plan.expiresAt || null,
    isFallback: !!plan.isFallback,
    version: data.version ?? null,
    converterDailyLimit: cfg.status === 200 ? cfg.data?.converter_daily_limit ?? null : null,
    quota: (quotaData.items || []).map((it) => ({
      feature: it.feature,
      label: it.label,
      status: it.status,
      used: it.used ?? 0,
      limit: it.limit ?? null,
      remaining: it.remaining ?? null,
      resetAt: it.reset_at || quotaData.reset_at || null,
    })),
    resetAt: quotaData.reset_at || null,
    raw: data,
  };
}

const QUOTA_NAMES = {
  basic_chat: 'Basic chat',
  agent_mode: 'Agent Mode',
  cron_trigger: 'Scheduled tasks',
  cloud_computer: 'Cloud computer',
};

const enDate = (value) => (value ? new Date(value).toLocaleString('en-US') : '—');

export function formatLimits(limits) {
  const lines = [
    `Plan:       ${String(limits.level).toUpperCase()} (${limits.planId})`,
    `Source:     ${limits.source}`,
    `Expires:    ${enDate(limits.expiresAt)}`,
    `Version:    ${limits.version ?? '—'}`,
  ];
  if (limits.resetAt) lines.push(`Resets:     ${enDate(limits.resetAt)}`);
  if (limits.converterDailyLimit != null) {
    lines.push(`Converter:  ${limits.converterDailyLimit} files/day`);
  }
  if (limits.quota?.length) {
    lines.push('');
    lines.push('Quotas:');
    for (const q of limits.quota) {
      const name = QUOTA_NAMES[q.feature] || q.label || q.feature;
      const value =
        q.status === 'unlimited'
          ? 'unlimited'
          : q.status === 'locked'
            ? 'locked'
            : `${q.used}/${q.limit ?? '?'} (${q.remaining ?? '?'} left)`;
      lines.push(`  ${name.padEnd(18)} ${value}`);
    }
  }
  return lines.join('\n');
}

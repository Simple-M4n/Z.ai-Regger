// Mailbox providers + verification-link extraction.
//
// Providers implement:
//   createInbox()                          -> { address, token?, ... }
//   waitForVerifyMail(inbox, {timeout, interval, log})
//                                           -> { content, subject, from } | null
//   name                                   -> short id for logs
//
// Providers: mailtm (free public API, zero config), cfmail (self-hosted
// cloudflare_temp_email), manual (operator pastes the link from any inbox).

import { randomBytes, randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline/promises';
import { Transport, sleep } from './http.js';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz0123456789';

export function randStr(len) {
  let out = '';
  const buf = randomBytes(len);
  for (let i = 0; i < len; i++) out += LETTERS[buf[i] % LETTERS.length];
  return out;
}

export function randPassword(len = 16) {
  const alphabet = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';
  const buf = randomBytes(len);
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[buf[i] % alphabet.length];
  return out;
}

// ── verification link extraction ────────────────────────────────

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, '&')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/gi, "'")
    .replace(/\\u0026/g, '&')
    .replace(/\\u003d/g, '=');
}

/**
 * Find the z.ai verification link/token in an email body (or a pasted URL).
 * Returns { url, token, email, username } or null.
 */
export function extractVerify(content) {
  if (!content) return null;
  const clean = decodeEntities(content);

  const patterns = [
    /https?:\/\/chat\.z\.ai\/auth\/verify_email\?[^\s<>"']+/gi,
    /(?:https?:\/\/)?chat\.z\.ai\/verify_email\?[^\s<>"']+/gi,
    /https?:\/\/chat\.z\.ai\/(?:auth\/)?verify_email[^"'\s]*/gi,
    /"(https?:\/\/[^"]*verify_email[^"]*)"/gi,
    /https?:\/\/[^\s"'<>]*verify[^\s"'<>]*token=[^\s"'<>]+/gi,
  ];

  for (const re of patterns) {
    for (const m of clean.matchAll(re)) {
      let raw = m[1] || m[0];
      raw = raw.replace(/[),.;]+$/, '');
      if (!/^https?:\/\//i.test(raw)) raw = `https://${raw}`;
      try {
        const u = new URL(raw);
        const token = u.searchParams.get('token');
        if (token) {
          return {
            url: u.toString(),
            token,
            email: u.searchParams.get('email'),
            username: u.searchParams.get('username') || u.searchParams.get('name'),
          };
        }
      } catch {
        /* try next match */
      }
    }
  }

  // bare "token=..." fallback
  const tm = clean.match(/token[=:]\s*([A-Za-z0-9\-_.]+)/i);
  if (tm) return { url: null, token: tm[1], email: null, username: null };

  return null;
}

const SENDER_RE = /z\.ai|chatglm|zhipu/i;
const SUBJECT_RE = /verif|verify|confirm|验证/i;

// ── mail.tm (public free API) ───────────────────────────────────

export class MailTmProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'mailtm';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
    this._domain = null;
  }

  async _domainName() {
    if (this._domain) return this._domain;
    const res = await this.t.json('https://api.mail.tm/domains');
    if (res.status >= 400) throw new Error(`mail.tm domains HTTP ${res.status}: ${res.text.slice(0, 150)}`);
    const members = res.data?.['hydra:member'] || [];
    const d = members.find((x) => x.isActive && !x.isPrivate) || members.find((x) => x.isActive);
    if (!d) throw new Error('mail.tm: no active domain available');
    this._domain = d.domain;
    return this._domain;
  }

  async createInbox() {
    const domain = await this._domainName();
    let lastErr = null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const address = `${randStr(12)}@${domain}`;
      const password = randomBytes(9).toString('base64url');

      const acc = await this.t.json('https://api.mail.tm/accounts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (acc.status === 429) {
        await sleep(2000);
        continue;
      }
      if (acc.status >= 400) {
        lastErr = new Error(`mail.tm account create HTTP ${acc.status}: ${acc.text.slice(0, 150)}`);
        continue;
      }

      const tok = await this.t.json('https://api.mail.tm/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ address, password }),
      });
      if (tok.status >= 400 || !tok.data?.token) {
        throw new Error(`mail.tm token HTTP ${tok.status}: ${tok.text.slice(0, 150)}`);
      }
      return { address, token: tok.data.token, accountId: tok.data.id };
    }
    throw lastErr || new Error('mail.tm: could not create inbox');
  }

  async _messages(inbox) {
    const res = await this.t.json('https://api.mail.tm/messages?page=1', {
      headers: { Authorization: `Bearer ${inbox.token}` },
    });
    if (res.status === 401) throw new Error('mail.tm: inbox session rejected (401)');
    if (res.status === 429) return null; // transient rate limit — caller retries
    if (res.status >= 400) throw new Error(`mail.tm messages HTTP ${res.status}`);
    return res.data?.['hydra:member'] || [];
  }

  async waitForVerifyMail(inbox, { timeout = 180000, interval = 5000, initialWait = 8000, log = console.log } = {}) {
    if (initialWait > 0) await sleep(initialWait);
    const deadline = Date.now() + timeout;
    const seen = new Set();

    while (Date.now() < deadline) {
      let msgs = null;
      try {
        msgs = await this._messages(inbox);
      } catch (err) {
        log(`  [mail] ${err.message}`);
      }

      if (msgs) {
        for (const m of msgs) {
          if (seen.has(m.id)) continue;
          seen.add(m.id);

          const from = `${m.from?.address || ''} ${m.from?.name || ''}`;
          const subject = m.subject || '';
          if (!SENDER_RE.test(from) && !SUBJECT_RE.test(subject)) continue;

          const full = await this.t.json(`https://api.mail.tm/messages/${m.id}`, {
            headers: { Authorization: `Bearer ${inbox.token}` },
          });
          const d = full.data;
          const content = `${(d?.html || []).join('\n')}\n${d?.text || ''}`;
          log(`  [mail] message from "${from.trim()}" subject="${subject}"`);

          if (extractVerify(content)) return { content, subject, from: from.trim() };
          log('  [mail] no verify link in this message — continuing to poll');
        }
      }

      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      log(`  [mail] waiting for verification mail... ${left}s left`);
      await sleep(interval);
    }
    return null;
  }
}

// ── tempmail.lol (public API, random domains) ───────────────────

export class TempMailProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null } = {}) {
    this.name = 'tempmail';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const res = await this.t.json('https://api.tempmail.lol/v2/inbox/create', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    if (res.status >= 400 || !res.data?.address || !res.data?.token) {
      throw new Error(`tempmail create HTTP ${res.status}: ${res.text.slice(0, 150)}`);
    }
    return { address: res.data.address, token: res.data.token };
  }

  async waitForVerifyMail(inbox, { timeout = 180000, interval = 5000, initialWait = 8000, log = console.log } = {}) {
    if (initialWait > 0) await sleep(initialWait);
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const url = `https://api.tempmail.lol/v2/inbox?token=${encodeURIComponent(inbox.token)}`;
      let res = null;
      try {
        res = await this.t.json(url);
      } catch (err) {
        log(`  [mail] ${err.message}`);
      }
      if (res && res.status < 400) {
        // v2 consumes the whole inbox on read — inspect every message now
        for (const m of res.data?.emails || []) {
          const from = m.from || '';
          const subject = m.subject || '';
          const content = `${m.html || ''}\n${m.body || ''}`;
          log(`  [mail] message from "${from}" subject="${subject}"`);
          if (extractVerify(content)) return { content, subject, from };
        }
      }
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      log(`  [mail] waiting for verification mail... ${left}s left`);
      await sleep(interval);
    }
    return null;
  }
}

// ── Guerrilla Mail (public API, no key) ──────────────────────────

export class GuerrillaProvider {
  constructor({ proxy = null, timeout = 20000, insecure = false, onRetry = null, domain = null } = {}) {
    this.name = 'guerrilla';
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
    this.domain = domain;
  }

  async _api(params) {
    const url = `https://api.guerrillamail.com/ajax.php?${new URLSearchParams(params)}`;
    const res = await this.t.json(url, { retries: 1 });
    if (res.status >= 400) throw new Error(`guerrilla API HTTP ${res.status}: ${res.text.slice(0, 150)}`);
    if (!res.data || typeof res.data !== 'object') throw new Error(`guerrilla API bad response: ${res.text.slice(0, 150)}`);
    return res.data;
  }

  async createInbox() {
    const s = await this._api({ f: 'get_email_address' });
    if (!s.email_addr || !s.sid_token) throw new Error('guerrilla: no address in response');
    let address = s.email_addr;
    if (this.domain) {
      const user = address.split('@')[0];
      const alt = await this._api({ f: 'set_email_user', sid_token: s.sid_token, email_user: user, domain: this.domain });
      if (alt.email_addr) address = alt.email_addr;
    }
    return { address, token: s.sid_token };
  }

  async waitForVerifyMail(inbox, { timeout = 180000, interval = 5000, initialWait = 8000, log = console.log } = {}) {
    if (initialWait > 0) await sleep(initialWait);
    const deadline = Date.now() + timeout;
    const seen = new Set();

    while (Date.now() < deadline) {
      let list = null;
      try {
        list = await this._api({ f: 'get_email_list', sid_token: inbox.token, offset: 0 });
      } catch (err) {
        log(`  [mail] ${err.message}`);
      }
      for (const m of list?.list || []) {
        if (seen.has(m.mail_id)) continue;
        seen.add(m.mail_id);
        const from = m.mail_from || '';
        const subject = m.mail_subject || '';
        if (!SENDER_RE.test(from) && !SUBJECT_RE.test(subject)) continue;
        const full = await this._api({ f: 'fetch_email', sid_token: inbox.token, email_id: m.mail_id });
        const content = `${full.mail_body || ''}\n${full.mail_html || ''}\n${full.mail_text || ''}`;
        log(`  [mail] message from "${from.trim()}" subject="${subject}"`);
        if (extractVerify(content)) return { content, subject, from: from.trim() };
      }
      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      log(`  [mail] waiting for verification mail... ${left}s left`);
      await sleep(interval);
    }
    return null;
  }
}

// ── self-hosted cloudflare_temp_email ───────────────────────────

export class CfMailProvider {
  constructor({ base, sitePassword = '', domain = null, proxy = null, timeout = 20000, insecure = false, onRetry = null }) {
    if (!base) throw new Error('cfmail provider requires --mail-base https://your-mail-instance');
    this.name = 'cfmail';
    this.base = base.replace(/\/+$/, '');
    this.sitePassword = sitePassword;
    this.domain = domain;
    this.t = new Transport({ proxy, timeout, insecure, onRetry });
  }

  async createInbox() {
    const body = {};
    if (this.domain) body.domain = this.domain;
    const res = await this.t.json(`${this.base}/api/new_address`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-custom-auth': this.sitePassword },
      body: JSON.stringify(body),
    });
    if (res.status >= 400 || !res.data?.address) {
      throw new Error(`cfmail create address HTTP ${res.status}: ${res.text.slice(0, 150)}`);
    }
    return { address: res.data.address, token: res.data.jwt || null };
  }

  async _parsedList(inbox) {
    const res = await this.t.json(`${this.base}/api/parsed_mails?limit=20&offset=0`, {
      headers: { Authorization: `Bearer ${inbox.token}` },
    });
    if (res.status >= 400) throw new Error(`cfmail parsed_mails HTTP ${res.status}`);
    return res.data?.results || [];
  }

  async waitForVerifyMail(inbox, { timeout = 180000, interval = 5000, initialWait = 8000, log = console.log } = {}) {
    if (initialWait > 0) await sleep(initialWait);
    const deadline = Date.now() + timeout;
    const seen = new Set();

    while (Date.now() < deadline) {
      let mails = [];
      try {
        mails = await this._parsedList(inbox);
      } catch (err) {
        log(`  [mail] ${err.message}`);
      }

      for (const m of mails) {
        if (seen.has(m.id)) continue;
        seen.add(m.id);
        const from = String(m.sender || m.source || '');
        const subject = m.subject || '';
        if (!SENDER_RE.test(from) && !SUBJECT_RE.test(subject)) continue;

        let full = null;
        try {
          const r = await this.t.json(`${this.base}/api/parsed_mail/${m.id}`, {
            headers: { Authorization: `Bearer ${inbox.token}` },
          });
          full = r.data;
        } catch {
          full = m;
        }
        const content = `${full?.html || ''}\n${full?.text || ''}`;
        log(`  [mail] message from "${from}" subject="${subject}"`);
        if (extractVerify(content)) return { content, subject, from };
      }

      const left = Math.max(0, Math.round((deadline - Date.now()) / 1000));
      log(`  [mail] waiting for verification mail... ${left}s left`);
      await sleep(interval);
    }
    return null;
  }
}

// ── manual: operator provides address + pastes the link ────────

export class ManualProvider {
  constructor({ email = null } = {}) {
    this.name = 'manual';
    this.email = email;
    this._asked = false;
  }

  async createInbox() {
    if (this.email && !this._asked) {
      this._asked = true;
      return { address: this.email };
    }
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    try {
      const addr = (await rl.question('  [manual] email address for this account: ')).trim();
      if (!addr || !addr.includes('@')) throw new Error('invalid email address');
      return { address: addr };
    } finally {
      rl.close();
    }
  }

  async waitForVerifyMail(_inbox, { timeout = 180000, log = console.log } = {}) {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      try {
        const answer = (
          await rl.question(`  [manual] paste the verify link (timeout ${Math.round(timeout / 1000)}s): `)
        ).trim();
        if (answer) return { content: answer, subject: '(manual paste)', from: 'manual' };
      } finally {
        rl.close();
      }
    }
    return null;
  }
}

// ── factory ─────────────────────────────────────────────────────

export function buildProvider(kind, opts) {
  switch (kind) {
    case 'mailtm':
      return new MailTmProvider(opts);
    case 'guerrilla':
      return new GuerrillaProvider(opts);
    case 'tempmail':
      return new TempMailProvider(opts);
    case 'cfmail':
      return new CfMailProvider(opts);
    case 'manual':
      return new ManualProvider(opts);
    default:
      throw new Error(`unknown provider "${kind}" (expected mailtm | tempmail | guerrilla | cfmail | manual)`);
  }
}

export { randomUUID };

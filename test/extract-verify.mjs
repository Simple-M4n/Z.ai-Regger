// Unit checks for verification-link extraction and failure classification.
// Run: node test/extract-verify.mjs
import { extractVerify } from '../lib/mail.js';
import { classifyFailure, extractJwt } from '../lib/zai.js';

let failed = 0;
const assert = (name, cond, extra = '') => {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? ` — ${extra}` : ''}`);
  if (!cond) failed += 1;
};

// 1. current link format, HTML-entity-encoded ampersands
const html = `<p>Confirm your email: <a href="https://chat.z.ai/auth/verify_email?token=verify-abc123XYZ&amp;email=user1%40euploading.com&amp;username=user1">Verify</a></p>`;
const r1 = extractVerify(html);
assert('html entity link', r1?.token === 'verify-abc123XYZ' && r1?.email === 'user1@euploading.com' && r1?.username === 'user1', JSON.stringify(r1));

// 2. legacy path, no scheme (rendered as plain text in some clients)
const legacy = 'Visit chat.z.ai/verify_email?token=verify-LEGACY-99&email=x@y.z to finish';
const r2 = extractVerify(legacy);
assert('legacy schemeless link', r2?.token === 'verify-LEGACY-99', JSON.stringify(r2));

// 3. JSON-escaped ampersands inside a JSON mail body
const jsonEsc = '{"text":"https://chat.z.ai/auth/verify_email?token=verify-j\\u0026done=1&email=a@b.c"}';
const r3 = extractVerify(jsonEsc);
assert('json escaped \\u0026', r3?.token === 'verify-j', JSON.stringify(r3));

// 4. bare pasted URL (manual provider returns the paste as content)
const pasted = 'https://chat.z.ai/auth/verify_email?token=verify-PASTED42&email=me@mail.tm';
const r4 = extractVerify(pasted);
assert('pasted bare url', r4?.token === 'verify-PASTED42' && r4?.url?.includes('verify_email'), JSON.stringify(r4));

// 5. bare token= fallback
const bare = 'something token=verify-ONLY-77 more';
const r5 = extractVerify(bare);
assert('bare token fallback', r5?.token === 'verify-ONLY-77', JSON.stringify(r5));

// 6. garbage returns null
assert('garbage -> null', extractVerify('no links here at all') === null);
assert('empty -> null', extractVerify('') === null);

// 7. failure classification
const cap = classifyFailure({ status: 400, text: '{"detail":"The captcha verification failed."}' });
assert('classify captcha', cap.kind === 'captcha', cap.kind);
const rl = classifyFailure({ status: 429, text: '{"detail":"Too many requests"}' });
assert('classify rate_limit', rl.kind === 'rate_limit', rl.kind);
const taken = classifyFailure({ status: 400, text: '{"detail":"User already exists"}' });
assert('classify email_taken', taken.kind === 'email_taken', taken.kind);

// 8. jwt extraction shapes
assert('jwt: user.token', extractJwt({ user: { token: 'aaa.bbb' } }) === 'aaa.bbb');
assert('jwt: top token', extractJwt({ token: 'ccc.ddd' }) === 'ccc.ddd');
assert('jwt: missing -> empty', extractJwt({ status: true }) === '');

process.exit(failed === 0 ? 0 : 1);

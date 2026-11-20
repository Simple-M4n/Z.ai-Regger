import { loadAccounts, loadConfig, usableAccounts, findAccount, jwtInfo } from '../lib/store.js';
import { getModels, getLimits, getProfile, formatLimits } from '../lib/api.js';
import { parseCompletion } from '../lib/chat.js';

const accounts = loadAccounts();
const config = loadConfig();
const acc = usableAccounts(accounts).at(-1);
console.log('account:', acc?.email, 'jwt:', jwtInfo(acc?.token));
console.log('find by last:', findAccount(accounts, 'last')?.email);

console.log('\n-- models --');
const models = await getModels(config, acc);
for (const m of models) console.log(m.id, '|', m.name, '|', m.efforts.join(','), '|', m.maxTokens);

console.log('\n-- profile --');
const me = await getProfile(config, acc);
console.log({ id: me.id, email: me.email, name: me.name, role: me.role });

console.log('\n-- limits --');
console.log(formatLimits(await getLimits(config, acc)));

console.log('\n-- sse parser --');
const sample = [
  'data: {"choices":[{"delta":{"reasoning_content":"думаю"}}]}',
  'data: {"choices":[{"delta":{"content":"Привет"}}]}',
  'data: {"choices":[{"delta":{"content":", мир!"}}]}',
  'data: [DONE]',
].join('\n');
console.log(parseCompletion(sample));

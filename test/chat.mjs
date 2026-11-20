import { loadAccounts, loadConfig, usableAccounts } from '../lib/store.js';
import { openChatSession } from '../lib/chat.js';

const acc = usableAccounts(loadAccounts()).at(-1);
const cfg = loadConfig();
const headed = process.argv.includes('--headed');

const session = await openChatSession({
  token: acc.token,
  model: cfg.model,
  effort: cfg.effort,
  headless: !headed,
  log: (m) => console.log(m),
});
try {
  const result = await session.send('Reply with exactly: PONG', { timeoutMs: 180000 });
  console.log('\nRESULT', JSON.stringify(result, null, 2));
} finally {
  await session.close();
}

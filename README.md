# zai-regger

[Русская версия](README.ru.md)

`zai-regger` is a small Node.js toolkit for Z.AI accounts. It does two things:

1. **`regger.js`** — automatic account registration: temporary mailbox → signup
   (the Aliyun slider is solved automatically) → verification email →
   `finish_signup` → JWT saved to `accounts.json`.
2. **`zai-regger.js`** — an interactive terminal client with two targets:
   - **ZChat** — `https://chat.z.ai`
   - **ZCode** — `https://zcode.z.ai/login` (sign in with Z.AI)

All behaviour is controlled by a single JSON file, `config.json`. There are no
hardcoded user paths, no branding from other projects, and no credentials in
this repository.

## Requirements

- Node.js ≥ 18.17
- `npm install` (installs `playwright-core`)
- Google Chrome or Microsoft Edge — detected automatically; can be forced in
  `config.json` or with `--browser`
- No Python required

## Quick start

```bash
npm install
node regger.js --selftest                 # network / mailbox / browser check
node regger.js --count 1                  # register one account
npm start                                 # or: node zai-regger.js
```

Install the global command with `npm link` (or `npm i -g .`), then run:

```bash
zai-regger
```

The global command reads `config.json` and `accounts.json` from the project
directory because both paths are resolved relative to the installed module.

## Configuration (`config.json`)

Every setting lives in `config.json`. Command-line flags override it and are
written back to the file, so the JSON file is always the source of truth.

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"ZChat"` | Target platform: `"ZChat"` or `"ZCode"` |
| `accountId` | `null` | Optional initial selector; the active account is kept in app-data `state.json` |
| `model` | `"x-preview-l"` | `GLM-5.3-Flash`; also `glm-5.3`, `glm-5.2` |
| `effort` | `"max"` | Reasoning effort: `low`, `high`, `max` |
| `headless` | `true` | `true` = background browser, `false` = visible window |
| `proxy` | `null` | `null` = direct connection, or `http(s)://[user:pass@]host:port` |
| `browser` | `null` | `null` = autodetect, otherwise `chrome`, `msedge`, `chromium` |
| `provider` | `"tempmail"` | Mail provider used by `regger.js` |
| `captcha` | `"auto"` | `auto`, `browser`, `param`, `none` |
| `autoAttempts` | `6` | Slider solver attempts per account |
| `interval` | `65` | Pause in seconds between registrations |
| `insecure` | `false` | Skip TLS certificate verification |
| `maxTranscript` | `2000` | Number of TUI history lines kept |
| `zcodeUrl` | `"https://zcode.z.ai/login"` | Z.AI SSO entry point for ZCode |
| `zcodeLocalUrl` | `"http://127.0.0.1:3030"` | Local ZCode web UI (`zcode --web`) |
| `loginTimeoutMs` | `180000` | Maximum wait for the ZCode login |

Example:

```json
{
  "mode": "ZCode",
  "accountId": null,
  "model": "x-preview-l",
  "effort": "max",
  "headless": false,
  "proxy": null,
  "browser": null,
  "provider": "tempmail",
  "captcha": "auto",
  "autoAttempts": 6
}
```

Set `"proxy": "http://127.0.0.1:7890"` to use a proxy, or leave it `null` for a
direct connection. Set `"headless": false` to watch the browser.

CLI overrides for the interactive client:

```bash
node zai-regger.js --mode ZCode
node zai-regger.js --proxy http://127.0.0.1:7890
node zai-regger.js --headed
node zai-regger.js --browser msedge
node zai-regger.js --config ./my-config.json
```

Environment overrides: `ZAI_REGGER_CONFIG` (config path),
`ZAI_REGGER_ACCOUNTS` (accounts path), `ZAI_REGGER_DEBUG=1` (driver logs).

## Interactive commands

| Command | Description |
|---|---|
| `/new` | Start a new conversation |
| `/newacc [count]` | Register account(s) through `regger.js` |
| `/switch [n\|email\|last]` | Switch the active account |
| `/accounts` | List accounts and JWT status |
| `/status` | Account, subscription, quota and limits |
| `/mode [low\|high\|max]` | Reasoning effort |
| `/target [ZCode\|ZChat]` | Switch target platform |
| `/zcode`, `/zchat` | Shortcuts for `/target` |
| `/config` | Show config path and active settings |
| `/models` | Fetch models from the API |
| `/agents` | Switch agent role (Build / Plan / Chat) |
| `/exit` | Exit |

Plain text is sent straight to the active target. `Ctrl+P` opens the command
palette, `Shift+Tab` switches agents, `PageUp` / `PageDown` and the mouse wheel
scroll the history, `t` or a click expands the last reasoning block.

Models available from `/api/models`:

| ID | Name |
|---|---|
| `x-preview-l` | GLM-5.3-Flash |
| `glm-5.3` | GLM-5.3 |
| `glm-5.2` | GLM-5.2 |

Aliases such as `glm-5.3-flash` and `flash` are accepted by `/model <id>`.

## Targets

### ZChat

The driver keeps a Playwright page at `https://chat.z.ai` logged in with the
JWT from the selected account. It sets `last_mode`, `last_selected_agent_model`,
`last_reasoning_effort` and onboarding flags in `localStorage`, then sends the
prompt through the real UI. A raw `POST /api/chat/completions` returns `404`
without the frontend signature and captcha context, so the browser path is
required. The live request is `POST /api/v2/chat/completions?...` and the reply
is SSE:

```text
data: {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"}}
```

### ZCode

`zcode.z.ai` is only the login/marketing site; the real agent workspace is the
local web UI served by `zcode --web` (default `http://127.0.0.1:3030`). ZCode
mode therefore runs in two stages in one browser context:

1. Complete the actual Z.AI SSO at `https://zcode.z.ai/login`: choose the Z.ai
   account login, pick "Continue with Email", fill the account credentials,
   solve the Aliyun slider, and accept the `ZCode would like to access your
   Z.ai account` consent screen.
2. Open `zcodeLocalUrl`, start a new task if needed, and send the prompt through
   the real composer (`v4-composer-input` / `chat-input`). The reply is read
   from the agent timeline.

If the local server is not running, the driver stops with an error that tells
you to start `zcode --web`. Change `"zcodeLocalUrl"` in `config.json` if your
ZCode web UI listens on a different address. Use `/target ZCode`,
`--mode ZCode` or `"mode": "ZCode"` in the config to select this target.

## Accounts and privacy

`accounts.json` in this repository is an empty template. Real credentials are
never committed:

- an `accounts.json` in the OS app-data directory
  (`%APPDATA%\Z.ai-Regger` on Windows, `~/Library/Application Support/Z.ai-Regger`
  on macOS, `~/.config/Z.ai-Regger` on Linux) is detected automatically;
- `accounts.local.json` in the project directory is an optional ignored
  override;
- the active account selector is saved to `state.json` next to that app-data
  file, so `config.json` never contains an email address;
- `ZAI_REGGER_ACCOUNTS` points to any other file.

`.gitignore` excludes accounts, tokens, logs and `debug/`. Do not paste real
emails, passwords or JWTs into issues or screenshots.

## Registrar options

```bash
node regger.js [options]
```

| Option | Default | Meaning |
|---|---|---|
| `--config FILE` | `config.json` | Alternative config file |
| `--count N` | `1` | Number of accounts |
| `--provider K` | from config | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `manual` |
| `--email ADDR` | – | Explicit address |
| `--password PW` | random | Password |
| `--name NAME` | email local part | Username |
| `--out FILE` | `accounts.json` | Output file |
| `--interval SEC` | `65` | Pause between accounts |
| `--captcha MODE` | `auto` | `auto`, `browser`, `param`, `none` |
| `--auto-attempts N` | `6` | Slider attempts per account |
| `--captcha-file FILE` | – | Pre-solved `captcha_verify_param` |
| `--captcha-timeout SEC` | `300` | Slider timeout |
| `--email-timeout SEC` | `180` | Verification mail timeout |
| `--no-wait-email` | off | Stop after signup |
| `--mail-base URL` | – | `cfmail` instance URL |
| `--mail-pass PASS` | – | `cfmail` site password |
| `--mail-domain DOM` | – | `cfmail` address domain |
| `--proxy URL` | from config | `http(s)://[user:pass@]host:port` |
| `--insecure` | from config | Skip TLS verification |
| `--browser CH` | autodetect | `chrome`, `msedge`, `chromium` |
| `--headed` | from config | Visible browser window |
| `--selftest` | – | Connectivity check, no registration |
| `-h`, `--help` | – | Help |

Registration flow:

```text
POST /api/v1/auths/signup          {name, email, password, captcha_verify_param, ...}
       ↓ poll the mailbox
GET  verification link              https://chat.z.ai/auth/verify_email?token=...
POST /api/v1/auths/verify_email     {username, email, token}
POST /api/v1/auths/finish_signup    {username, email, token, password, ...} → JWT
       ↓
accounts.json
```

Statuses: `complete` (JWT received), `verified_no_token`, `email_pending`,
`failed` (see `error`).

Notes:

- `tempmail` currently has the best chance of passing domain filtering;
  `mailtm` and `guerrilla` domains are rejected by chat.z.ai.
- Aliyun WAF may return `405` after several signups from one IP. The tool
  classifies it as `waf_block` and stops the batch; wait 10–30 minutes or use a
  proxy.
- Captcha tokens are single-use; every account needs a fresh slider pass.
- Re-runs are safe: records are appended, not overwritten.

## Tests

```bash
node regger.js --selftest
node test/extract-verify.mjs
node test/slider-analyzer.mjs
node test/api.mjs       # models, profile, quota, SSE parser (needs a JWT)
node test/chat.mjs      # live ZChat smoke test (needs a JWT + browser)
```

## Publishing

This directory is ready for `https://github.com/Simple-M4n/Z.ai-Regger`.
Before pushing, confirm that `accounts.json` contains `[]`, that `config.json`
has no passwords or tokens, and that no `debug/` directory or `.log` files are
included.

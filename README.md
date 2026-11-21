# zai-regger

[Русская версия](README.ru.md)

`zai-regger` registers Z.AI accounts automatically. It is a command-line tool
only: there is no chat client, interactive shell or slash commands.

Flow per account: temporary mailbox → `chat.z.ai` signup (the Aliyun slider is
solved automatically) → verification email → `verify_email` + `finish_signup` →
JWT saved to the accounts file.

All behaviour is controlled by `config.json` plus CLI flags. No hardcoded user
paths, no branding from other projects, and no credentials in this repository.

## Requirements

- Node.js ≥ 18.17
- `npm install` (installs `playwright-core`)
- Google Chrome or Microsoft Edge — autodetected, or set `browser` in config
- No Python required

## Quick start

```bash
npm install
node zai-regger.js --help
node zai-regger.js --selftest              # network / mailbox / browser check
node zai-regger.js --count 1               # register one account
node zai-regger.js --mode ZCode --count 1  # same flow, tagged as ZCode
```

Every CLI flag overrides `config.json` for that run only. To make a setting
permanent, edit `config.json`.

## Modes

Both `ZChat` and `ZCode` are supported and selectable with `--mode` or the
`mode` field in `config.json`. They share the same Z.AI registration flow; the
selected mode is recorded on every account entry for later use.

## config.json

| Field | Default | Meaning |
|---|---|---|
| `mode` | `"ZChat"` | Account label: `"ZChat"` or `"ZCode"` |
| `headless` | `true` | `true` = background browser, `false` = visible window |
| `proxy` | `null` | Proxy URL/object, or `null` for a direct connection |
| `proxyType` | `null` | Default type for a bare `host:port` proxy |
| `proxyFile` | `null` | File with a proxy list, rotated once per account |
| `proxyBypass` | `null` | Comma-separated hosts bypassing the proxy (browser only) |
| `browser` | `null` | `null` = autodetect, otherwise `chrome`, `msedge`, `chromium` |
| `provider` | `"tempmail"` | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `manual` |
| `captcha` | `"auto"` | `auto`, `browser`, `param`, `none` |
| `autoAttempts` | `10` | Slider solver attempts per account |
| `interval` | `65` | Pause in seconds between registrations |
| `insecure` | `false` | Skip TLS certificate verification |
| `verbose` | `false` | Print detailed slider/form diagnostics |

Example:

```json
{
  "mode": "ZCode",
  "headless": true,
  "proxy": "socks5://127.0.0.1:1080",
  "proxyType": null,
  "proxyBypass": null,
  "browser": null,
  "provider": "tempmail",
  "captcha": "auto",
  "autoAttempts": 10,
  "interval": 65,
  "insecure": false,
  "verbose": false
}
```

## Proxy

Supported types: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.
The scheme in the URL selects the type; a bare `host:port` is treated as HTTP
unless `proxyType` (or `--proxy-type`) says otherwise.

```json
"proxy": "http://user:pass@proxy.example:8080"
"proxy": "socks5://user:pass@127.0.0.1:1080"
"proxy": { "type": "socks4", "host": "127.0.0.1", "port": 1080 }
```

With a bare address, set the type separately:

```json
"proxy": "127.0.0.1:1080",
"proxyType": "socks5"
```

The same via CLI:

```bash
node zai-regger.js --proxy socks5://user:pass@127.0.0.1:1080 --count 1
node zai-regger.js --proxy 127.0.0.1:1080 --proxy-type socks4 --count 1
node zai-regger.js --proxy http://proxy.example:8080 --proxy-bypass localhost --count 1
node zai-regger.js --proxy none --count 1   # disable the config proxy
```

Proxy credentials are applied to both the Node HTTP requests (mail/API) and
the browser. Keep real credentials out of the published repo: use an external
config file via `ZAI_REGGER_CONFIG` when storing a proxy password.

## CLI options

Run `node zai-regger.js --help` for the full list. Main flags:

- `--mode ZChat|ZCode`, `--count N`, `--provider K`, `--interval SEC`
- `--captcha auto|browser|param|none`, `--auto-attempts N`, `--captcha-file FILE`
- `--proxy URL`, `--proxy-type TYPE`, `--proxy-file LIST`, `--proxy-bypass LIST`
- `--browser CHANNEL`, `--headed`, `--insecure`
- `--out FILE`, `--selftest`, `--verbose`

## Proxy rotation

Aliyun ties captcha risk state to the exit IP, so one address for a whole batch
makes later accounts much harder to pass. Put one proxy per line (or a JSON
array) in a local file and pass `--proxy-file proxies.txt` — each account gets
the next proxy. `#` comments and blank lines are ignored; bare `host:port`
entries use `--proxy-type`. The proxy file is never copied into the repository.

## Accounts and privacy

Registered accounts are written outside the repository by default
(`%APPDATA%\Z.ai-Regger\accounts.json` on Windows, equivalent config directory
elsewhere). Override with `--out` or `ZAI_REGGER_ACCOUNTS`. The committed
`accounts.json` is an empty `[]` template; no real accounts, JWTs, passwords
or logs belong in the repository. The solver also keeps a small
`slider-memory.json` next to `accounts.json`: it stores only a perceptual hash
of reused puzzle images and the gap that passed, never image bytes or account
data.

## Tests

```bash
npm test
node zai-regger.js --selftest
```

The slider solver writes no debug files by default. Set `ZAI_SLIDER_DEBUG=1`
to save puzzle images and screenshots under `debug/` when investigating failures.

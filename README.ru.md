# zai-regger

[English version](README.md)

`zai-regger` — небольшой набор инструментов Node.js для аккаунтов Z.AI. Он делает
две вещи:

1. **`regger.js`** — автоматическая регистрация аккаунта: временная почта →
   signup (слайдер Aliyun решается сам) → письмо подтверждения →
   `finish_signup` → JWT сохраняется в `accounts.json`.
2. **`zai-regger.js`** — интерактивный терминальный клиент с двумя режимами:
   - **ZChat** — `https://chat.z.ai`
   - **ZCode** — `https://zcode.z.ai/login` (вход через Z.AI)

Всё поведение задаётся одним JSON-файлом `config.json`. В репозитории нет
жёстко заданных путей пользователя, чужих брендов и реальных учётных данных.

## Требования

- Node.js ≥ 18.17
- `npm install` (устанавливает `playwright-core`)
- Google Chrome или Microsoft Edge — определяется автоматически, можно задать
  в `config.json` или через `--browser`
- Python не нужен

## Быстрый старт

```bash
npm install
node regger.js --selftest                 # проверка сети, почты и браузера
node regger.js --count 1                  # зарегистрировать один аккаунт
npm start                                 # или: node zai-regger.js
```

Глобальную команду можно поставить через `npm link` (или `npm i -g .`), после
чего запускать так:

```bash
zai-regger
```

Глобальная команда читает `config.json` и `accounts.json` из каталога проекта,
поскольку пути вычисляются относительно установленного модуля.

## Конфигурация (`config.json`)

Все настройки находятся в `config.json`. Флаги командной строки перекрывают его
и записываются обратно в файл, поэтому JSON всегда является источником правды.

| Поле | По умолчанию | Назначение |
|---|---|---|
| `mode` | `"ZChat"` | Целевая платформа: `"ZChat"` или `"ZCode"` |
| `accountId` | `null` | Необязательный стартовый выбор; активный аккаунт хранится в `state.json` каталога данных ОС |
| `model` | `"x-preview-l"` | `GLM-5.3-Flash`; также `glm-5.3`, `glm-5.2` |
| `effort` | `"max"` | Уровень reasoning: `low`, `high`, `max` |
| `headless` | `true` | `true` — фоновый браузер, `false` — видимое окно |
| `proxy` | `null` | `null` — без прокси, либо `http(s)://[user:pass@]host:port` |
| `browser` | `null` | `null` — автоопределение, иначе `chrome`, `msedge`, `chromium` |
| `provider` | `"tempmail"` | Почтовый провайдер для `regger.js` |
| `captcha` | `"auto"` | `auto`, `browser`, `param`, `none` |
| `autoAttempts` | `6` | Число попыток решения слайдера на аккаунт |
| `interval` | `65` | Пауза в секундах между регистрациями |
| `insecure` | `false` | Не проверять TLS-сертификаты |
| `maxTranscript` | `2000` | Число строк истории TUI |
| `zcodeUrl` | `"https://zcode.z.ai/login"` | Точка входа Z.AI SSO для ZCode |
| `zcodeLocalUrl` | `"http://127.0.0.1:3030"` | Локальный веб-интерфейс ZCode (`zcode --web`) |
| `loginTimeoutMs` | `180000` | Максимальное ожидание входа в ZCode |

Пример:

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

Чтобы использовать прокси, укажите `"proxy": "http://127.0.0.1:7890"`; чтобы
работать напрямую — оставьте `null`. Для видимого окна поставьте
`"headless": false`.

Флаги для интерактивного клиента:

```bash
node zai-regger.js --mode ZCode
node zai-regger.js --proxy http://127.0.0.1:7890
node zai-regger.js --headed
node zai-regger.js --browser msedge
node zai-regger.js --config ./my-config.json
```

Переменные окружения: `ZAI_REGGER_CONFIG` (путь к конфигу),
`ZAI_REGGER_ACCOUNTS` (путь к аккаунтам), `ZAI_REGGER_DEBUG=1` (логи драйвера).

## Интерактивные команды

| Команда | Назначение |
|---|---|
| `/new` | Новый диалог |
| `/newacc [count]` | Зарегистрировать аккаунт(ы) через `regger.js` |
| `/switch [n\|email\|last]` | Переключить активный аккаунт |
| `/accounts` | Список аккаунтов и статус JWT |
| `/status` | Аккаунт, подписка, квоты и лимиты |
| `/mode [low\|high\|max]` | Уровень reasoning |
| `/target [ZCode\|ZChat]` | Переключить платформу |
| `/zcode`, `/zchat` | Короткие варианты `/target` |
| `/config` | Путь к конфигу и текущие настройки |
| `/models` | Список моделей из API |
| `/agents` | Роль агента (Build / Plan / Chat) |
| `/exit` | Выход |

Обычный текст отправляется сразу в активный режим. `Ctrl+P` открывает палитру
команд, `Shift+Tab` переключает агентов, `PageUp`/`PageDown` и колесо мыши
листают историю, `t` или клик раскрывают последний блок рассуждений.

Модели из `/api/models`:

| ID | Имя |
|---|---|
| `x-preview-l` | GLM-5.3-Flash |
| `glm-5.3` | GLM-5.3 |
| `glm-5.2` | GLM-5.2 |

Команда `/model <id>` принимает и псевдонимы: `glm-5.3-flash`, `flash`.

## Режимы

### ZChat

Драйвер держит страницу `https://chat.z.ai` в Playwright и авторизует её через
JWT выбранного аккаунта. В `localStorage` выставляются `last_mode`,
`last_selected_agent_model`, `last_reasoning_effort` и флаги подавления
онбординга. Прямой `POST /api/chat/completions` без фронтенд-подписи и капчи
возвращает `404`, поэтому используется реальная страница. Фактический запрос —
`POST /api/v2/chat/completions?...`, ответ в формате SSE:

```text
data: {"type":"chat:completion","data":{"delta_content":"...","phase":"thinking"}}
```

### ZCode

`zcode.z.ai` — это только сайт входа и маркетинговая страница; настоящая рабочая
область агента — локальный веб-интерфейс, который поднимается командой
`zcode --web` (по умолчанию `http://127.0.0.1:3030`). Поэтому режим ZCode
работает в два этапа в одном контексте браузера:

1. Выполняется реальный вход Z.AI SSO на `https://zcode.z.ai/login`: выбор
   входа через аккаунт Z.ai, «Continue with Email», ввод логина и пароля,
   решение слайдера Aliyun и подтверждение экрана «ZCode would like to access
   your Z.ai account».
2. Открывается `zcodeLocalUrl`, при необходимости создаётся новая задача, и
   запрос отправляется через настоящее поле ввода (`v4-composer-input` /
   `chat-input`). Ответ читается из ленты агента.

Если локальный сервер не запущен, драйвер выдаёт ошибку с рекомендацией
выполнить `zcode --web`. Если веб-интерфейс слушает другой адрес, измените
`"zcodeLocalUrl"` в `config.json`. Переключение: `/target ZCode`,
`--mode ZCode` или `"mode": "ZCode"` в конфиге.

## Аккаунты и приватность

`accounts.json` в репозитории — пустой шаблон. Реальные данные не попадают в
git:

- `accounts.json` в каталоге данных ОС (`%APPDATA%\Z.ai-Regger` в Windows,
  `~/Library/Application Support/Z.ai-Regger` в macOS,
  `~/.config/Z.ai-Regger` в Linux) определяется автоматически;
- `accounts.local.json` в каталоге проекта — необязательный игнорируемый
  файл с локальными данными;
- выбор активного аккаунта сохраняется в `state.json` рядом с файлом аккаунтов,
  поэтому в `config.json` никогда не оказывается email;
- `ZAI_REGGER_ACCOUNTS` задаёт произвольный путь.

`.gitignore` исключает аккаунты, токены, логи и `debug/`. Не вставляйте реальные
email, пароли и JWT в issue или скриншоты.

## Опции regger.js

```bash
node regger.js [options]
```

| Опция | По умолчанию | Назначение |
|---|---|---|
| `--config FILE` | `config.json` | Альтернативный конфиг |
| `--count N` | `1` | Число аккаунтов |
| `--provider K` | из конфига | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `manual` |
| `--email ADDR` | – | Явный адрес |
| `--password PW` | случайный | Пароль |
| `--name NAME` | local part | Имя пользователя |
| `--out FILE` | `accounts.json` | Файл результатов |
| `--interval SEC` | `65` | Пауза между аккаунтами |
| `--captcha MODE` | `auto` | `auto`, `browser`, `param`, `none` |
| `--auto-attempts N` | `6` | Попыток слайдера на аккаунт |
| `--captcha-file FILE` | – | Готовый `captcha_verify_param` |
| `--captcha-timeout SEC` | `300` | Ожидание слайдера |
| `--email-timeout SEC` | `180` | Ожидание письма |
| `--no-wait-email` | off | Остановиться после signup |
| `--mail-base URL` | – | URL инстанса `cfmail` |
| `--mail-pass PASS` | – | Пароль сайта `cfmail` |
| `--mail-domain DOM` | – | Домен адреса `cfmail` |
| `--proxy URL` | из конфига | `http(s)://[user:pass@]host:port` |
| `--insecure` | из конфига | Не проверять TLS |
| `--browser CH` | авто | `chrome`, `msedge`, `chromium` |
| `--headed` | из конфига | Видимое окно |
| `--selftest` | – | Проверка без регистрации |
| `-h`, `--help` | – | Справка |

Поток регистрации:

```text
POST /api/v1/auths/signup          {name, email, password, captcha_verify_param, ...}
       ↓ опрос ящика
GET  ссылка подтверждения           https://chat.z.ai/auth/verify_email?token=...
POST /api/v1/auths/verify_email     {username, email, token}
POST /api/v1/auths/finish_signup    {username, email, token, password, ...} → JWT
       ↓
accounts.json
```

Статусы: `complete` (JWT получен), `verified_no_token`, `email_pending`,
`failed` (см. `error`).

Особенности:

- `tempmail` чаще всего проходит фильтр доменов; домены `mailtm` и
  `guerrilla` chat.z.ai отклоняет.
- Aliyun WAF может вернуть `405` после нескольких signup с одного IP. Инструмент
  классифицирует это как `waf_block` и останавливает батч; подождите 10–30 минут
  или используйте прокси.
- Токен капчи одноразовый — для каждого аккаунта нужен новый слайдер.
- Повторные запуски безопасны: записи дописываются, а не перезаписываются.

## Проверки

```bash
node regger.js --selftest
node test/extract-verify.mjs
node test/slider-analyzer.mjs
node test/api.mjs       # модели, профиль, квоты, парсер SSE (нужен JWT)
node test/chat.mjs      # живой тест ZChat (нужны JWT и браузер)
```

## Публикация

Каталог готов для `https://github.com/Simple-M4n/Z.ai-Regger`. Перед пушем
убедитесь, что `accounts.json` содержит `[]`, в `config.json` нет паролей и
токенов, а каталог `debug/` и файлы `.log` не включены.

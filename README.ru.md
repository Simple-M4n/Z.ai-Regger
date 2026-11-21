# zai-regger

[English version](README.md)

`zai-regger` автоматически регистрирует аккаунты Z.AI. Это только CLI-утилита:
никакого чата, интерактивной оболочки и команд вроде `/config`.

Один аккаунт: временная почта → регистрация на `chat.z.ai` (слайдер Aliyun
решается автоматически) → письмо подтверждения → `verify_email` +
`finish_signup` → JWT сохраняется в файл аккаунтов.

Вся настройка — через `config.json` и флаги CLI. В репозитории нет путей
конкретного пользователя, чужих названий и реальных учётных данных.

## Требования

- Node.js ≥ 18.17
- `npm install` (устанавливает `playwright-core`)
- Google Chrome или Microsoft Edge — определяются автоматически, либо поле
  `browser` в конфиге
- Python не нужен

## Быстрый старт

```bash
npm install
node zai-regger.js --help
node zai-regger.js --selftest              # проверка сети, почты и браузера
node zai-regger.js --count 1               # зарегистрировать один аккаунт
node zai-regger.js --mode ZCode --count 1  # тот же поток, пометка ZCode
```

Каждый флаг CLI переопределяет `config.json` только для текущего запуска.
Чтобы сделать настройку постоянной, измените `config.json`.

## Режимы

Поддерживаются оба режима — `ZChat` и `ZCode`; они выбираются флагом `--mode`
или полем `mode` в `config.json`. Поток регистрации у них одинаковый, выбранный
режим записывается в каждую запись аккаунта.

## config.json

| Поле | По умолчанию | Назначение |
|---|---|---|
| `mode` | `"ZChat"` | Метка аккаунта: `"ZChat"` или `"ZCode"` |
| `headless` | `true` | `true` — фоновый браузер, `false` — видимое окно |
| `proxy` | `null` | URL/объект прокси либо `null` (прямое соединение) |
| `proxyType` | `null` | Тип по умолчанию для прокси вида `host:port` |
| `proxyBypass` | `null` | Хосты через запятую, минующие прокси (только браузер) |
| `browser` | `null` | `null` — автоопределение, иначе `chrome`, `msedge`, `chromium` |
| `provider` | `"tempmail"` | `mailtm`, `tempmail`, `guerrilla`, `cfmail`, `manual` |
| `captcha` | `"auto"` | `auto`, `browser`, `param`, `none` |
| `autoAttempts` | `10` | Число попыток решения слайдера на аккаунт |
| `interval` | `65` | Пауза в секундах между регистрациями |
| `insecure` | `false` | Не проверять TLS-сертификаты |

Пример:

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
  "insecure": false
}
```

## Прокси

Поддерживаемые типы: `http`, `https`, `socks4`, `socks4a`, `socks5`, `socks5h`.
Тип выбирается схемой в URL; адрес вида `host:port` считается HTTP, если не
указан `proxyType` (или флаг `--proxy-type`).

```json
"proxy": "http://user:pass@proxy.example:8080"
"proxy": "socks5://user:pass@127.0.0.1:1080"
"proxy": { "type": "socks4", "host": "127.0.0.1", "port": 1080 }
```

С адресом без схемы тип задаётся отдельно:

```json
"proxy": "127.0.0.1:1080",
"proxyType": "socks5"
```

То же через CLI:

```bash
node zai-regger.js --proxy socks5://user:pass@127.0.0.1:1080 --count 1
node zai-regger.js --proxy 127.0.0.1:1080 --proxy-type socks4 --count 1
node zai-regger.js --proxy http://proxy.example:8080 --proxy-bypass localhost --count 1
node zai-regger.js --proxy none --count 1   # отключить прокси из конфига
```

Прокси применяется и к сетевым запросам Node (почта/API), и к браузеру. Не
кладите реальные логины и пароли в публикуемый репозиторий: для конфига с
секретами используйте внешний файл через `ZAI_REGGER_CONFIG`.

## Флаги CLI

Полный список: `node zai-regger.js --help`. Основные:

- `--mode ZChat|ZCode`, `--count N`, `--provider K`, `--interval SEC`
- `--captcha auto|browser|param|none`, `--auto-attempts N`, `--captcha-file FILE`
- `--proxy URL`, `--proxy-type TYPE`, `--proxy-bypass LIST`
- `--browser CHANNEL`, `--headed`, `--insecure`
- `--out FILE`, `--selftest`

## Аккаунты и приватность

По умолчанию аккаунты записываются вне репозитория
(`%APPDATA%\Z.ai-Regger\accounts.json` в Windows, аналогичный каталог конфига
в других системах). Переопределить можно флагом `--out` или переменной
`ZAI_REGGER_ACCOUNTS`. Файл `accounts.json` в репозитории — пустой шаблон `[]`;
реальные аккаунты, JWT, пароли и логи в репозиторий не добавляются.

## Тесты

```bash
npm test
node zai-regger.js --selftest
```

Решатель слайдера по умолчанию не пишет отладочные файлы. Установите
`ZAI_SLIDER_DEBUG=1`, чтобы сохранить изображения пазла и скриншоты в `debug/`.

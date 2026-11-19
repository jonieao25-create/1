# Архивная копия

Эта папка — **не источник истины** для Worker `newbuilds-leads`.

Канонический проект: `D:\Claud Cod\Evgeniy_Z\newbuilds-miniapp` (в нём живут
`index.html`, `data.js`, фотографии и рабочая версия `worker/index.js`).

Почему: `repo1` содержит байт-в-байт копию `worker/index.js` из `newbuilds-miniapp`
и один и тот же `wrangler.toml` с `name = "newbuilds-leads"`. Два одинаковых
конфига на один Worker — источник случайных деплоев не той версии.

Правило: правки кода и конфигурации Worker'а вносить только в
`Evgeniy_Z/newbuilds-miniapp`. Эту папку не деплоить.

Статус на 19.11.2026: 7 918 байт, версия до появления бота-секретаря и статистики.
Актуальный опубликованный код — в `D:\Claud Cod\_cloudflare_backups\2026-11-19\newbuilds-leads.js`.

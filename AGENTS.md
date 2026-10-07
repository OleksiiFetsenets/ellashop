# Notes for AI agents

- **Translations / UI languages:** read `app/static/lang/AI.md` first. It explains the language
  files, the format rules, the vocabulary and how to check a translation.
- **User-visible text in code:** never hard-code English. Add it to `app/static/lang/en/*.json`
  and use `t('id')` (JS), `data-i18n="id"` (HTML) or `tr('id')` (server). Details in the same file.
- **Tests:** `bash tests/ui_test.sh` (browser journeys; needs Node 22+, Google Chrome and `app/.venv`).

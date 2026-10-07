# UI strings

Every piece of text the user sees lives here, Android `res/values` style.

- `en/` is the source language. Each area has its own file (`common.json`, `passport.json`, …); all files of a language are merged, so an id must be unique across files.
- Ids are flat `snake_case`, prefixed by area: `passport_right`, `collage_margin_error`.
- Placeholders are positional like Android: `%1$s` text, `%2$d` whole number, `%3$.1f` number with one decimal, `%%` a percent sign.
- Plurals are objects with CLDR forms: `{"one": "%1$d photo", "other": "%1$d photos"}` (add `few`/`many` for languages that need them). The first argument picks the form.
- In code: `t('passport_right')`, `t('passport_aligned_count', n)`. In HTML: `data-i18n="id"` (text), `data-i18n-title`, `data-i18n-placeholder`, `data-i18n-aria-label`, `data-i18n-html` (only for strings that contain markup).
- Server messages use the same files through `tr('id', ...)` in `server.py`.

## Adding a language

1. Copy `en/` to a new folder named by language code, e.g. `ru/` or `uk/`, and translate the values (never the ids). Missing ids fall back to English.
   Every language folder must define `language_name` as that language's own name (endonym).
2. Set `"language": "ru"` in `app/settings.json` and restart Ellashop.

Folder and file names on disk (Exported, Passport 3.5x4.5, …) stay English on purpose.

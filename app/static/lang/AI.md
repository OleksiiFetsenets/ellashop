# Instructions for AI agents (LLMs): translating Ellashop

You are an AI model or coding agent asked to add or update a UI language for Ellashop.
Read this whole file before writing anything. It tells you what the files are, the exact
format rules, the domain vocabulary, and how to check your work. Human-oriented notes are in
`README.md` next to this file; this file is the complete, self-contained version for you.

## 1. What Ellashop is (context for word choice)

A desktop photo editor for **photo-printing shops**. The person using it is a shop employee
preparing customer photos for printing: cropping to print sizes, making canvas prints, and
making passport/visa photo sheets that are cut with a **guillotine cutter**. Tone: short,
plain, practical, like the labels on professional software. Use the formal/polite register
where a language distinguishes it, unless told otherwise.

## 2. Where the text lives

```
app/static/lang/
  en/            <- SOURCE language (English). Never delete or rename ids here.
    common.json  page.json  prints.json  canvas.json  passport.json
    collage.json editor.json settings.json server.json
  <code>/        <- one folder per language, e.g. ru/, uk/, de/, pt-BR/
  README.md      <- notes for humans
  AI.md          <- this file
```

- A language folder is named by its code: two lowercase letters (`ru`, `uk`, `de`), optionally
  a region (`pt-BR`, `zh-Hans`). Other names are ignored by the app.
- All `*.json` files of one language are merged. File names only group strings by app area;
  mirror the English file names (create `ru/passport.json` for `en/passport.json`, and so on).
- Every file is a flat JSON object: `"id": value`. Ids are unique across all files.
- The app loads English first and then overlays the chosen language, so **any id you leave out
  shows in English**. A partial translation is valid; a wrong one is not.

## 3. The task: add a language

1. Create `app/static/lang/<code>/`.
2. For every file in `en/`, create the same file name in `<code>/` with the **same ids** and
   translated values. Keep the ids in the same order as English (easier review).
3. Set `language_name` (in `common.json`) to the language's own name in that language:
   `"Русский"`, `"Українська"`, `"Deutsch"` — not the English name. This is what the
   language picker in Settings shows.
   Also set `language_direction` (in `common.json`): `"rtl"` for right-to-left languages
   (Hebrew `he`, Arabic `ar`, Persian `fa`), otherwise `"ltr"`. The app mirrors its layout for `rtl`.
4. Run the checks in section 7. Fix everything they report.
5. To try it: Settings → Language, or set `"language": "<code>"` in `app/settings.json` and
   restart Ellashop.

To **update** a language after English changed: compare ids (section 7 lists missing and
stale ones), translate the missing ids, delete ids that no longer exist in English.

## 4. Format rules (these break the app if violated)

| Rule | Example |
|---|---|
| Never translate or change an **id** (the key). | `"passport_right"` stays `"passport_right"` |
| Keep every **placeholder** exactly, with the same number and type. You may move it within the sentence. | `%1$s` text, `%2$d` whole number, `%3$.1f` number with 1 decimal, `%%` a literal % |
| Placeholders are positional: `%2$s` is always the second value, wherever you put it. | EN `"%1$s has %2$s mm"` → DE `"%1$s hat %2$s mm"` or any order that is natural |
| Do not add placeholders that the English string does not have. | |
| **Plurals** are objects. Keep the object, translate each form, and add the forms your language needs (CLDR plural categories: `zero`, `one`, `two`, `few`, `many`, `other`). `other` is required. The number deciding the form is always the first value (`%1$d`). Use exactly the categories your language has: Russian/Ukrainian `one, few, many, other`; Hebrew `one, two, other`; German/Spanish/French `one, other` (French also `many`). | EN `{"one": "%1$d photo", "other": "%1$d photos"}` → RU `{"one": "%1$d фото", "few": "%1$d фото", "many": "%1$d фото", "other": "%1$d фото"}` |
| Values are plain text, not HTML. Do not add tags. | |
| Valid JSON, UTF-8, double quotes; write real characters (no `\u` escapes needed). Escape `"` inside a value as `\"`. | |
| **Do not touch the math.** See section 4a. | |
| Unit words may be written the way your language writes them (`мм`, `см`, `מ״מ`, `ס״מ`); the numbers next to them stay as they are. | |
| Keep the product name `Ellashop`, `VISA`, `Photoroom`, `JPEG`, `PNG`, `DPI`, `ZIP` untranslated. | |
| Keep translations about as short as the English for buttons, tabs and short labels: they sit in narrow side panels. | |

## 4a. Math and measurements stay exactly as written

Ellashop prints to exact sizes, so every number and formula in the strings is data, not prose.
Copy these character for character; translate only the words around them:

- Sizes and grids: `10 × 15`, `3.5 × 4.5`, `N × N`, `%1$s × %2$s cm`, `Cols × Rows` (translate the
  words "Cols"/"Rows", keep the `×` and its spaces). Never replace `×` with `x`, `*` or `на`.
- Numbers: keep digits and the decimal **point** as in English (`3.5`, `0.5`), even if your language
  normally writes a decimal comma. Do not convert units (no inches, no cm↔mm changes).
- Ranges, ratios and percentages: `32–36 mm`, `70–80%`, `1:1`, `±`, `°` stay as written.
- Arithmetic or comparison symbols (`+`, `−`, `=`, `<`, `>`, `/`) and the order of the values
  around them stay as written.
- Right-to-left languages: write the sentence right to left as usual, but keep each size, range or
  formula in its original left-to-right order (`10 × 15`, not `15 × 10`).

If a string is nothing but a number, size or formula, its translation is identical to English.

## 5. Vocabulary (use one consistent translation for each)

| English | Meaning in this app |
|---|---|
| print | a photo printed on paper (10×15 cm etc.) |
| canvas / gallery wrap | a photo printed on canvas stretched over a frame; the "wrap" is the part folded around the frame's sides |
| passport photo / sheet | ID photos; several identical copies are placed on one 10×15 sheet and cut apart |
| cut lines / guillotine | thin lines printed on the sheet showing where to cut |
| margin / Right / Down | white space on the sheet: Right moves the block of photos right, Down moves it down |
| crop / crop to fill | cut the photo to the print shape |
| fit, white border / blurred border | show the whole photo with white or blurred-photo bars |
| collage | several different photos placed in cells on one sheet |
| cell, gap | one photo place in a collage; the space between cells |
| order | a customer's set of photos (Prints tab) |
| incoming folder | the folder where new customer photos arrive |
| export / Exported | the finished print-ready files and their folder |
| density | print brightness correction (lighter/darker) |
| auto align / face guides | automatic placement of the head between guide lines |
| sticker, overlay | text or graphics placed on top of a photo |

## 6. What you must not translate or touch

- Ids, file names, folder names, JSON structure.
- Anything outside `app/static/lang/`. Code changes are not part of a translation task.
- The `en/` folder, unless you were explicitly asked to change English wording.

Some English remains on screen on purpose and is **not** in these files: folder names on disk
(`Exported`, `Passport 3.5x4.5`, `photos/incoming`), font names, colour codes. Do not try to
translate those.

## 7. Check your work (run from the repository root)

```bash
python3 - ru <<'EOF'
import json, re, sys, pathlib
code = sys.argv[1]; base = pathlib.Path("app/static/lang")
load = lambda d: {k: v for f in sorted((base / d).glob("*.json")) for k, v in json.loads(f.read_text(encoding="utf-8")).items()}
en, tr = load("en"), load(code)
ph = lambda v: sorted(set(re.findall(r"%(?:\d+\$)?(?:\.\d+)?[sdf]", json.dumps(v, ensure_ascii=False))))
missing = [k for k in en if k not in tr]; stale = [k for k in tr if k not in en]
bad = [k for k in tr if k in en and ph(tr[k]) != ph(en[k])]
shape = [k for k in tr if k in en and isinstance(en[k], dict) != isinstance(tr[k], dict) or (isinstance(tr.get(k), dict) and "other" not in tr[k])]
print(f"{code}: {len(tr)}/{len(en)} ids translated")
print("missing (shown in English):", missing or "none")
print("stale (not in English, delete):", stale or "none")
print("placeholder mismatch (MUST fix):", bad or "none")
print("plural shape wrong (MUST fix):", shape or "none")
EOF
```

Replace `ru` with your language code. `placeholder mismatch` and `plural shape wrong` must be
`none`; invalid JSON makes the script fail with the file and line. Then open Ellashop, switch
to the language and look at each tab (Prints, Canvas, Passport photos, Collage, Settings) for
text that is too long or reads wrongly in context.

## 8. If you are writing code (not translating)

- Never put user-visible English in code. Add the string to the right `en/*.json` file
  (by area; ids are `snake_case` prefixed by area, e.g. `passport_…`, `collage_…`) and use it:
  - JavaScript: `t('id', value1, value2)` — `app/static/js/i18n.js`.
  - HTML: `data-i18n="id"` (text), `data-i18n-title`, `data-i18n-placeholder`,
    `data-i18n-aria-label`.
  - Python server messages: `tr('id', value1)` in `app/server.py`.
- Build whole sentences with placeholders; never glue translated pieces together, because word
  order differs between languages. Use a plural object for anything with a count.
- Other language folders do not need updating when you add an English id: missing ids fall
  back to English until a translator adds them.

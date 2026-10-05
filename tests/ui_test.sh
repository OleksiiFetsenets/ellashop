#!/bin/bash
# Browser tests (needs Node 22+ and Google Chrome): starts Ellashop on port 8799 with throw-away data (never touches photos/),
# runs every journey in tests/ui/ in order and prints ✓/✗ per step. Screenshots go to the temp folder.
set -u
cd "$(dirname "$0")/.."
# UI_TEST_PORT picks another port (journeys are rewritten from localhost:8799 on the fly).
PORT=${UI_TEST_PORT:-8799}
# Refuse to run when something already listens on the port (e.g. a manual test build on real photos):
# the journeys would drive that server instead, and 5_full_cleanup deletes everything it holds.
if curl -s -m1 http://localhost:$PORT/api/version >/dev/null; then
  echo "Port $PORT is already in use — stop that Ellashop first."; exit 2
fi
PY=${PYTHON:-app/.venv/bin/python3}   # PYTHON=… points at another Python with Pillow
DATA=$(mktemp -d)
# Test photos go into incoming; recreated before each journey because 5_full_cleanup empties incoming.
make_photos() {
mkdir -p "$DATA/incoming"
"$PY" - "$DATA/incoming" <<'PYEOF'
import sys
from PIL import Image, ImageDraw
for i, (w, h) in enumerate([(3000, 2000), (2000, 3000)] * 3):  # test0–test5 (Collage uses all six)
    im = Image.new('RGB', (w, h)); d = ImageDraw.Draw(im)
    for y in range(0, h, 10): d.rectangle((0, y, w, y + 10), fill=(40 + y * 150 // h, 90, 200 - y * 120 // h))
    d.ellipse((w//2 - 300, h//3 - 380, w//2 + 300, h//3 + 380), fill=(225, 185, 150))
    d.rectangle((w//2 - 600, h//3 + 380, w//2 + 600, h), fill=(30, 30, 40))
    im.save(f'{sys.argv[1]}/test{i}.jpg', quality=92)
PYEOF
}
make_photos
ELLASHOP_DATA="$DATA" "$PY" -c "
import sys; sys.path.insert(0, 'app'); import server
server.prepare(); server.make_server($PORT).serve_forever()" > "$DATA/server.log" 2>&1 &
SERVER=$!
trap 'kill $SERVER 2>/dev/null; wait $SERVER 2>/dev/null' EXIT
for _ in $(seq 1 40); do curl -s -m1 http://localhost:$PORT/api/version >/dev/null && break; sleep 0.25; done
status=0
for flow in tests/ui/*.json; do
  make_photos
  echo "== $(basename "$flow")"
  sed "s#localhost:8799#localhost:$PORT#g" "$flow" > "$DATA/steps.json"
  if node tests/run_flow.mjs "$DATA/steps.json" "$DATA/shots/$(basename "$flow" .json)" > "$DATA/flow.log" 2>&1; then
    echo "   passed ($(grep -c '✓ step' "$DATA/flow.log") steps)"
  else
    status=1; grep -E '✗ step' "$DATA/flow.log" | sed 's/^/   /'
  fi
done
# 6_collage saves one sheet: it must be a real 10×15 cm print, 1181×1772 px at 300 DPI.
if ! "$PY" - "$DATA/print_ready/Collage" <<'PYEOF'
import sys
from pathlib import Path
from PIL import Image
files = sorted(Path(sys.argv[1]).glob('collage_1_*.jpg'))
im = Image.open(files[0]) if files else None
ok = bool(im) and im.size == (1181, 1772) and tuple(round(v) for v in im.info.get('dpi', (0, 0))) == (300, 300)
print('== collage export', 'passed' if ok else f'FAILED: {files[0].name if files else "no file"} {im.size if im else ""}')
sys.exit(0 if ok else 1)
PYEOF
then status=1; fi
echo "screenshots: $DATA/shots"
exit $status

#!/usr/bin/env python3
"""Build fl-alarm-standalone.html: the whole app in ONE file (inline classic script, no modules, no service worker),
so it also works when opened from local storage (file://) on a phone. Usage: python3 build-standalone.py"""
import re, pathlib

here = pathlib.Path(__file__).parent
core = (here / "alarm-core.js").read_text(encoding="utf-8")
app = (here / "app.js").read_text(encoding="utf-8")
html = (here / "index.html").read_text(encoding="utf-8")

core = re.sub(r"^export ", "", core, flags=re.M)            # export const/function -> plain declarations
app = re.sub(r'^import .*?from "\./alarm-core\.js"\n', "", app, flags=re.M)  # the core is inlined above
app = re.sub(r'^if \("serviceWorker" in navigator\).*\n', "", app, flags=re.M)  # no service worker over file://
script = "(function () {\n" + core + "\n" + app + "\n})();"
assert "import " not in script.replace("// ", ""), "an import is still left in the script"
html = html.replace('<link rel="manifest" href="manifest.webmanifest" />\n', "")
import base64
_ico = "data:image/png;base64," + base64.b64encode((here / "icons/icon-192.png").read_bytes()).decode()
html = html.replace("icons/icon-192.png", _ico)
html = html.replace('<script type="module" src="app.js"></script>', "<script>\n" + script + "\n</script>")
out = here / "fl-alarm-standalone.html"
out.write_text(html, encoding="utf-8")
print(f"wrote {out} ({out.stat().st_size} bytes)")

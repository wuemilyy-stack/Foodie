"""Escape non-ASCII in foodiepass-website.html and rebuild netlify-deploy/index.html + foodiepass-netlify.zip.

Run:  python3 tools/build_site.py   (from the Foodie folder)
- HTML text  -> &#x....;
- inside <style> -> \\XXXX (CSS escape)
- inside <script> -> \\uXXXX (JS escape; astral chars become surrogate pairs)
"""
import os, re, sys, zipfile

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC = os.path.join(ROOT, 'foodiepass-website.html')
DEPLOY = os.path.join(ROOT, 'netlify-deploy')

HEAD = '''<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="description" content="FoodiePass: one $30 yearly pass for deals at independent restaurants across Houston. Restaurants join free.">
<meta name="theme-color" content="#172A2A">
'''


def js_esc(ch):
    cp = ord(ch)
    if cp > 0xFFFF:
        cp -= 0x10000
        return '\\u%04x\\u%04x' % (0xD800 + (cp >> 10), 0xDC00 + (cp & 0x3FF))
    return '\\u%04x' % cp


def escape(text):
    out, mode, i = [], 'html', 0
    tag = re.compile(r'<(/?)(script|style)\b[^>]*>', re.I)
    pos = 0
    for m in tag.finditer(text):
        out.append(convert(text[pos:m.start()], mode))
        out.append(m.group(0))
        mode = 'html' if m.group(1) else m.group(2).lower()
        pos = m.end()
    out.append(convert(text[pos:], mode))
    return ''.join(out)


def convert(chunk, mode):
    def rep(m):
        ch = m.group(0)
        if mode == 'script':
            return js_esc(ch)
        if mode == 'style':
            return '\\%04X ' % ord(ch)
        return '&#x%X;' % ord(ch)
    return re.sub(r'[^\x00-\x7F]', rep, chunk)


def main():
    with open(SRC, encoding='utf-8') as f:
        src = f.read()
    src = escape(src)
    if not src.startswith('<meta charset="utf-8">'):
        src = '<meta charset="utf-8">\n' + src
    with open(SRC, 'w', encoding='utf-8', newline='\n') as f:
        f.write(src)

    body = src.split('\n', 1)[1]  # drop the charset line; HEAD has it
    head_part, rest = body.split('</style>\n', 1)
    page = HEAD + head_part + '</style>\n</head>\n<body>\n' + rest.rstrip('\n') + '\n</body>\n</html>\n'
    assert not re.search(r'[^\x00-\x7F]', page), 'non-ASCII left in page'
    os.makedirs(DEPLOY, exist_ok=True)
    with open(os.path.join(DEPLOY, 'index.html'), 'w', encoding='utf-8', newline='\n') as f:
        f.write(page)
    with zipfile.ZipFile(os.path.join(ROOT, 'foodiepass-netlify.zip'), 'w', zipfile.ZIP_DEFLATED) as z:
        for name in ('index.html', '_headers'):
            p = os.path.join(DEPLOY, name)
            if os.path.exists(p):
                z.write(p, name)
    print('ok', len(page), 'bytes')


if __name__ == '__main__':
    sys.exit(main())

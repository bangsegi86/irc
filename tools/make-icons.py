#!/usr/bin/env python3
"""사랑방 아이콘 만들기 (시안 3: ㅅ 글자표, 하늘색).
클라이언트 = 하늘색 바탕에 흰 ㅅ, 서버 = 짙은 회색 바탕에 하늘색 ㅅ + 받침대.
필요한 도구: rsvg-convert, ImageMagick(convert).  실행: python3 tools/make-icons.py
"""
import os, subprocess, tempfile

SKY, SKY_LIGHT, SLATE, WHITE = '#2FA4E7', '#5CC0F7', '#2B303B', '#FFFFFF'
RED, GREEN, GRAY = '#E5484D', '#35C46A', '#8A929E'
ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

CLIENT = f'<rect x="4" y="4" width="56" height="56" rx="15" fill="{SKY}"/><path d="M32 17 17 47M32 17l15 30" fill="none" stroke="{WHITE}" stroke-width="9" stroke-linecap="round" stroke-linejoin="round"/>'
SERVER = f'<rect x="4" y="4" width="56" height="56" rx="15" fill="{SLATE}"/><path d="M32 13 19 38M32 13l13 25" fill="none" stroke="{SKY_LIGHT}" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"/><rect x="13" y="45" width="38" height="7" rx="3.5" fill="{WHITE}"/><circle cx="20" cy="48.5" r="1.9" fill="{SLATE}"/><circle cx="26.5" cy="48.5" r="1.9" fill="{SLATE}"/>'
# 트레이용(16px)은 여백 없이 꽉 채우고, 상태 점을 크게 그린다
def tray(body, dot=None):
    d = f'<circle cx="48" cy="48" r="16" fill="{WHITE}"/><circle cx="48" cy="48" r="12.5" fill="{dot}"/>' if dot else ''
    return f'<g transform="translate(32 32) scale(1.14) translate(-32 -32)">{body}</g>{d}'
DOT_ONLY = f'<circle cx="32" cy="32" r="30" fill="{WHITE}"/><circle cx="32" cy="32" r="24" fill="{RED}"/>'

def svg(inner): return f'<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64" viewBox="0 0 64 64">{inner}</svg>'
def png(inner, size, out):
    with tempfile.NamedTemporaryFile('w', suffix='.svg', delete=False, encoding='utf-8') as f: f.write(svg(inner))
    subprocess.run(['rsvg-convert', '-w', str(size), '-h', str(size), f.name, '-o', out], check=True)
    os.unlink(f.name)
def ico(inner, out):
    with tempfile.TemporaryDirectory() as d:
        files = []
        for s in (16, 24, 32, 48, 64, 128, 256):
            p = os.path.join(d, f'{s}.png'); png(inner, s, p); files.append(p)
        subprocess.run(['convert', *files, out], check=True)

for app, body, states in (('client', CLIENT, {'tray': None, 'tray-alert': RED}), ('server', SERVER, {'tray-on': GREEN, 'tray-off': GRAY})):
    a = os.path.join(ROOT, app, 'assets'); os.makedirs(a, exist_ok=True)
    png(body, 256, os.path.join(a, 'icon.png'))
    ico(body, os.path.join(a, 'icon.ico'))
    open(os.path.join(a, 'icon.svg'), 'w', encoding='utf-8').write(svg(body))
    for name, dot in states.items():
        png(tray(body, dot), 16, os.path.join(a, f'{name}.png'))
        png(tray(body, dot), 32, os.path.join(a, f'{name}@2x.png'))
png(DOT_ONLY, 32, os.path.join(ROOT, 'client', 'assets', 'overlay-alert.png'))
print('아이콘을 만들었습니다:', os.path.join(ROOT, 'client', 'assets'), os.path.join(ROOT, 'server', 'assets'))

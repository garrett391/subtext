"""Rasterizes the dumped SVGs. cairosvg predates oklch(), so those colours are
converted to sRGB hex first — the same maths the browser does."""
import re, sys, math
import cairosvg

def oklch_to_hex(L, C, H):
    h = math.radians(H)
    a, b = C * math.cos(h), C * math.sin(h)
    l_ = L + 0.3963377774 * a + 0.2158037573 * b
    m_ = L - 0.1055613458 * a - 0.0638541728 * b
    s_ = L - 0.0894841775 * a - 1.2914855480 * b
    l, m, s = l_**3, m_**3, s_**3
    r = +4.0767416621*l - 3.3077115913*m + 0.2309699292*s
    g = -1.2684380046*l + 2.6097574011*m - 0.3413193965*s
    bl = -0.0041960863*l - 0.7034186147*m + 1.7076147010*s
    def enc(x):
        x = max(0.0, min(1.0, x))
        x = 1.055 * x ** (1/2.4) - 0.055 if x > 0.0031308 else 12.92 * x
        return round(max(0.0, min(1.0, x)) * 255)
    return '#%02x%02x%02x' % (enc(r), enc(g), enc(bl))

pattern = re.compile(r'oklch\(\s*([\d.]+)\s+([\d.]+)\s+([\d.]+)\s*\)')
for name in sys.argv[1:]:
    svg = open(f'out-{name}.svg').read()
    svg = pattern.sub(lambda m: oklch_to_hex(*map(float, m.groups())), svg)
    cairosvg.svg2png(bytestring=svg.encode(), write_to=f'/tmp/{name}.png', scale=2)
    print('rendered', name)

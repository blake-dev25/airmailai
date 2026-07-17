import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';

const CX = 170;
const CY = 62;
const R = 44;
const VIEW = 124;
const STROKE = 3;
const ROTATION = -22.5;
const BAR_NUDGE_X = 20.5;
const BAR_NUDGE_Y = 0;
const WAVE_AMP = 4;
const WAVELENGTH = 33;
const WAVE_PHASE_DEG = 345;
const BAR_SPACING = 17;
const REACH = 0.25;
const BAR_LEN = 42;
const BAR_COUNT = 4;
const TEXT = 'AirmailAI';
const TEXT_SIZE = 16;
const SMALL_CAPS_SCALE = 0.75;
const TEXT_RADIUS = 28;
const LETTER_SPACING = 0.5;
const BULLET_DISTANCE = 32;
const BULLET_SIZE = 4;
const INNER_R = 21;
const BARS_COLOR = '#c14227';
const CIRCLE_COLOR = '#26214d';
const TEXT_COLOR = '#26214d';
const BG_COLOR = '#f0e1c3';
const PNG_SIZES = [16, 32, 48, 64, 128, 180, 192, 256, 512, 1024];
const EXT_ICON_SIZES = [16, 32, 48, 128];

const LORA_CSS_URL = 'https://fonts.googleapis.com/css2?family=Lora:wght@600';
const LEGACY_UA =
    'Mozilla/5.0 (Linux; U; Android 4.0.4; en-us; Galaxy Nexus Build/IMM76B) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30';

const STATIC_DIR = join(
    import.meta.dirname,
    '../packages/airmailai_web/static'
);
const LIB_DIR = join(import.meta.dirname, '../packages/airmailai_web/src/lib');
const EXT_PUBLIC_DIR = join(
    import.meta.dirname,
    '../packages/airmailai_ext/public'
);

const ATTRIBUTION =
    'AirmailAI postmark logo. Lettering traced from Lora SemiBold, (c) The Lora Project Authors, licensed under the SIL Open Font License 1.1.';

function wavePath(y: number): string {
    const x0 = CX - R - BAR_LEN + BAR_NUDGE_X;
    const x1 = CX - R + REACH * R + BAR_NUDGE_X;
    const k = (2 * Math.PI) / WAVELENGTH;
    const phase = (WAVE_PHASE_DEG * Math.PI) / 180;
    const wy = (x: number) => y - WAVE_AMP * Math.sin(k * (x - x0) + phase);
    let d = `M ${x0.toFixed(2)} ${wy(x0).toFixed(2)}`;
    for (let x = x0 + 1; x < x1; x += 1) {
        d += ` L ${x.toFixed(2)} ${wy(x).toFixed(2)}`;
    }
    d += ` L ${x1.toFixed(2)} ${wy(x1).toFixed(2)}`;
    return d;
}

async function fetchLoraSemiBold(): Promise<ArrayBuffer> {
    const cssRes = await fetch(LORA_CSS_URL, {
        headers: { 'User-Agent': LEGACY_UA },
    });
    if (!cssRes.ok) {
        throw new Error(`Lora CSS fetch failed: HTTP ${cssRes.status}`);
    }
    const css = await cssRes.text();
    const match = css.match(/url\((https:[^)]+)\)/);
    if (!match) {
        throw new Error(`no font url in Google Fonts CSS response:\n${css}`);
    }
    const fontRes = await fetch(match[1]);
    if (!fontRes.ok) {
        throw new Error(`Lora TTF fetch failed: HTTP ${fontRes.status}`);
    }
    return fontRes.arrayBuffer();
}

const font = parse(await fetchLoraSemiBold());

type ArcGlyph = { pathData: string; x: number; y: number; rotDeg: number };

function arcGlyphs(): ArcGlyph[] {
    const chars = [...TEXT].map((ch) => {
        const small = /[a-z]/.test(ch);
        const size = small ? TEXT_SIZE * SMALL_CAPS_SCALE : TEXT_SIZE;
        const glyphChar = ch.toUpperCase();
        return {
            glyphChar,
            size,
            advance: font.getAdvanceWidth(glyphChar, size),
        };
    });
    const total =
        chars.reduce((sum, c) => sum + c.advance, 0) +
        LETTER_SPACING * (chars.length - 1);
    const glyphs: ArcGlyph[] = [];
    let s = -total / 2;
    for (const c of chars) {
        const sCenter = s + c.advance / 2;
        const theta = -Math.PI / 2 + sCenter / TEXT_RADIUS;
        glyphs.push({
            pathData: font
                .getPath(c.glyphChar, -c.advance / 2, 0, c.size)
                .toPathData(2),
            x: CX + TEXT_RADIUS * Math.cos(theta),
            y: CY + TEXT_RADIUS * Math.sin(theta),
            rotDeg: (theta * 180) / Math.PI + 90,
        });
        s += c.advance + LETTER_SPACING;
    }
    return glyphs;
}

const glyphs = arcGlyphs();

function textArcs(color: string, indent: string): string {
    const paths = glyphs
        .map(
            (g) =>
                `${indent}        <path transform="translate(${g.x.toFixed(2)} ${g.y.toFixed(2)}) rotate(${g.rotDeg.toFixed(2)})" d="${g.pathData}" />`
        )
        .join('\n');
    return `${indent}<g fill="${color}">
${paths}
${indent}</g>
${indent}<g fill="${color}" transform="rotate(180 ${CX} ${CY})">
${paths}
${indent}</g>`;
}

const barYs = Array.from(
    { length: BAR_COUNT },
    (_, i) =>
        CY + BAR_NUDGE_Y - ((BAR_COUNT - 1) / 2) * BAR_SPACING + i * BAR_SPACING
);

const squareX = CX + R + STROKE / 2 + 6 - VIEW;

function logoBody(
    circleColor: string,
    circleFill: string,
    textColor: string,
    barsColor: string,
    indent: string
): string {
    const bars = barYs
        .map((y) => `${indent}        <path d="${wavePath(y)}" />`)
        .join('\n');
    return `${indent}<g transform="translate(${-squareX} 0) rotate(${ROTATION} ${CX} ${CY})">
${indent}    <circle cx="${CX}" cy="${CY}" r="${R}" fill="${circleFill}" stroke="${circleColor}" stroke-width="${STROKE}" />
${indent}    <circle cx="${CX}" cy="${CY}" r="${INNER_R}" fill="none" stroke="${circleColor}" stroke-width="${STROKE}" />
${indent}    <circle cx="${CX - BULLET_DISTANCE}" cy="${CY}" r="${BULLET_SIZE}" fill="${textColor}" />
${indent}    <circle cx="${CX + BULLET_DISTANCE}" cy="${CY}" r="${BULLET_SIZE}" fill="${textColor}" />
${indent}    <g fill="none" stroke="${barsColor}" stroke-width="${STROKE}" stroke-linecap="round">
${bars}
${indent}    </g>
${textArcs(textColor, `${indent}    `)}
${indent}</g>`;
}

const staticSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${VIEW} ${VIEW}">
    <title>AirmailAI</title>
    <desc>${ATTRIBUTION}</desc>
${logoBody(CIRCLE_COLOR, BG_COLOR, TEXT_COLOR, BARS_COLOR, '    ')}
</svg>
`;

writeFileSync(join(STATIC_DIR, 'airmailai-stamp-logo.svg'), staticSvg);
console.log(`wrote airmailai-stamp-logo.svg (${staticSvg.length} bytes)`);

function renderPng(size: number): Buffer {
    return new Resvg(staticSvg, { fitTo: { mode: 'width', value: size } })
        .render()
        .asPng();
}

for (const size of PNG_SIZES) {
    const png = renderPng(size);
    const name = `airmailai-stamp-logo-${size}.png`;
    writeFileSync(join(STATIC_DIR, name), png);
    console.log(`wrote ${name} (${png.length} bytes)`);
}

mkdirSync(EXT_PUBLIC_DIR, { recursive: true });
for (const size of EXT_ICON_SIZES) {
    const png = renderPng(size);
    const name = `icon-${size}.png`;
    writeFileSync(join(EXT_PUBLIC_DIR, name), png);
    console.log(`wrote ext ${name} (${png.length} bytes)`);
}

const component = `<script lang="ts">
    let { size = 44 }: { size?: number } = $props();
</script>

<svg viewBox="0 0 ${VIEW} ${VIEW}" width={size} height={size} aria-hidden="true">
    <title>AirmailAI</title>
    <desc>${ATTRIBUTION}</desc>
${logoBody('var(--color-fg)', 'none', 'var(--color-fg)', 'var(--color-accent-fg)', '    ')}
</svg>
`;

writeFileSync(join(LIB_DIR, 'StampLogo.svelte'), component);
console.log(`wrote StampLogo.svelte (${component.length} bytes)`);

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';

const W = 1200;
const H = 630;
const RED = '#c14227';
const NAVY = '#26214d';
const BEIGE = '#f0e1c3';

const SIDEBAR_W = 256;
const SCALE = W / SIDEBAR_W;
const stripeH = 20 * SCALE;
const stripeW = 40 * SCALE;
const gap = 40 * SCALE;
const pitch = stripeW + gap;
const phase = -22 * SCALE;

const logoSize = 44 * SCALE;
const logoTextGap = 8 * SCALE;
const fontSize = 34 * SCALE;
const letterSpacing = -0.02;

const STATIC_DIR = join(
    import.meta.dirname,
    '../packages/airmailai_web/static'
);

const startI = -Math.ceil(stripeH / pitch) - 1;
const endI = Math.ceil(W / pitch) + 1;
const stripes = Array.from({ length: endI - startI + 1 }, (_, idx) => {
    const i = startI + idx;
    const x = i * pitch + phase;
    return {
        points: `${x + stripeH},0 ${x + stripeH + stripeW},0 ${x + stripeW},${stripeH} ${x},${stripeH}`,
        red: i % 2 === 0,
    };
});
const stripePolygons = stripes
    .map(
        (s) =>
            `        <polygon points="${s.points}" fill="${s.red ? RED : NAVY}" />`
    )
    .join('\n');

const georgiaBold = readFileSync('C:/Windows/Fonts/georgiab.ttf');
const font = parse(
    georgiaBold.buffer.slice(
        georgiaBold.byteOffset,
        georgiaBold.byteOffset + georgiaBold.byteLength
    )
);

const probe = font.getPath('AirmailAI', 0, 0, fontSize, { letterSpacing });
const bb = probe.getBoundingBox();
const inkW = bb.x2 - bb.x1;

const contentW = logoSize + logoTextGap + inkW;
const contentX = (W - contentW) / 2;
const centerY = stripeH + (H - stripeH) / 2;

const logoX = contentX;
const logoY = centerY - logoSize / 2;
const textDx = contentX + logoSize + logoTextGap - bb.x1;
const textDy = centerY - (bb.y1 + bb.y2) / 2;
const textPathData = font
    .getPath('AirmailAI', textDx, textDy, fontSize, { letterSpacing })
    .toPathData(2);

const logoSvg = readFileSync(
    join(STATIC_DIR, 'airmailai-stamp-logo.svg'),
    'utf-8'
).replace(
    '<svg ',
    `<svg x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" `
);

const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}">
    <rect width="${W}" height="${H}" fill="${BEIGE}" />
    <g>
${stripePolygons}
    </g>
    ${logoSvg}
    <path d="${textPathData}" fill="${NAVY}" />
</svg>
`;

const png = new Resvg(svg, { fitTo: { mode: 'width', value: W } })
    .render()
    .asPng();
const name = 'airmailai-og-1200x630.png';
writeFileSync(join(STATIC_DIR, name), png);
console.log(`wrote ${name} (${png.length} bytes)`);

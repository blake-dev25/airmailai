import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse } from 'opentype.js';
import { Resvg } from '@resvg/resvg-js';

const DESIGN_WIDTH = 1200;
const RED = '#c14227';
const NAVY = '#26214d';
const BEIGE = '#f0e1c3';

const SIDEBAR_W = 256;
const SCALE = DESIGN_WIDTH / SIDEBAR_W;
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
const endI = Math.ceil(DESIGN_WIDTH / pitch) + 1;
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

const lockupW = logoSize + logoTextGap + inkW;
const lockupH = logoSize;
const logoSvgSource = readFileSync(
    join(STATIC_DIR, 'airmailai-stamp-logo.svg'),
    'utf-8'
);

function renderLockup(logoX: number, logoY: number, wordmarkColor: string) {
    const centerY = logoY + logoSize / 2;
    const textDx = logoX + logoSize + logoTextGap - bb.x1;
    const textDy = centerY - (bb.y1 + bb.y2) / 2;
    const textPathData = font
        .getPath('AirmailAI', textDx, textDy, fontSize, { letterSpacing })
        .toPathData(2);

    const logoSvg = logoSvgSource.replace(
        '<svg ',
        `<svg x="${logoX}" y="${logoY}" width="${logoSize}" height="${logoSize}" `
    );

    return `${logoSvg}
    <path d="${textPathData}" fill="${wordmarkColor}" />`;
}

function writeCard(
    width: number,
    height: number,
    name: string,
    tagline?: string
) {
    const viewBoxHeight = (height * DESIGN_WIDTH) / width;
    const taglineFontSize = 36;
    const taglineGap = 36;
    const taglinePath = tagline
        ? font.getPath(tagline, 0, 0, taglineFontSize)
        : undefined;
    const taglineBounds = taglinePath?.getBoundingBox();
    const taglineHeight = taglineBounds
        ? taglineBounds.y2 - taglineBounds.y1
        : 0;
    const contentHeight = logoSize + (tagline ? taglineGap + taglineHeight : 0);
    const logoX = (DESIGN_WIDTH - lockupW) / 2;
    const logoY = stripeH + (viewBoxHeight - stripeH) / 2 - contentHeight / 2;
    const taglineSvg =
        taglinePath && taglineBounds
            ? `<path d="${taglinePath.toPathData(2)}" fill="${NAVY}" transform="translate(${(DESIGN_WIDTH - taglineBounds.x2 - taglineBounds.x1) / 2} ${logoY + logoSize + taglineGap - taglineBounds.y1})" />`
            : '';

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${DESIGN_WIDTH} ${viewBoxHeight}">
    <rect width="${DESIGN_WIDTH}" height="${viewBoxHeight}" fill="${BEIGE}" />
    <g>
${stripePolygons}
    </g>
    ${renderLockup(logoX, logoY, NAVY)}
    ${taglineSvg}
</svg>
`;

    const png = new Resvg(svg).render().asPng();
    writeFileSync(join(STATIC_DIR, name), png);
    console.log(`wrote ${name} (${png.length} bytes)`);
}

function writeLockupSvg(name: string, wordmarkColor: string) {
    const pad = 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lockupW + pad * 2} ${lockupH + pad * 2}">
    <title>AirmailAI</title>
    ${renderLockup(pad, pad, wordmarkColor)}
</svg>
`;
    writeFileSync(join(STATIC_DIR, name), svg);
    console.log(`wrote ${name} (${svg.length} bytes)`);
}

writeCard(1200, 630, 'airmailai-og-1200x630.png');
writeCard(1200, 400, 'airmailai-banner-1200x400.png');
writeCard(440, 280, 'airmailai-promo-small-440x280.png');
writeCard(1400, 560, 'airmailai-promo-marquee-1400x560.png');
writeCard(
    1280,
    800,
    'airmailai-promo-1280x800.png',
    'The fast, secure, and private BYOK LLM chat app.'
);
writeLockupSvg('airmailai-logo-wordmark.svg', '#000000');
writeLockupSvg('airmailai-logo-wordmark-dark.svg', '#ffffff');

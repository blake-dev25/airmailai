import { Resvg } from '@resvg/resvg-js';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';

// Lucide 'construction' icon, ISC license (lucide-icons/lucide).
// https://lucide.dev/icons/construction
// Inlined rather than read from a package: @lucide/svelte (already a dep) ships
// the icon only as a Svelte component, and the path data lives inside an
// iconNode array in the .svelte file - not importable from a plain node script.
const CONSTRUCTION_PATHS = `
  <rect x="2" y="6" width="20" height="8" rx="1" />
  <path d="M17 14v7" />
  <path d="M7 14v7" />
  <path d="M17 3v3" />
  <path d="M7 3v3" />
  <path d="M10 14 2.3 6.3" />
  <path d="m14 6 7.7 7.7" />
  <path d="m8 6 8 8" />
`.trim();

const STROKE_COLOR = '#ffffff';
const SIZES = [16, 32];
const ICON_RATIO = 0.9;

const outDir = join(import.meta.dirname, '../packages/courierai_web/static');

for (const size of SIZES) {
    const iconPx = size * ICON_RATIO;
    const offset = (size - iconPx) / 2;
    const scale = iconPx / 24;
    const visualStroke = Math.max(1.5, size * 0.08);
    const strokeIn24 = visualStroke / scale;

    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
  <g transform="translate(${offset} ${offset}) scale(${scale})" fill="none" stroke="${STROKE_COLOR}" stroke-width="${strokeIn24}" stroke-linecap="round" stroke-linejoin="round">
    ${CONSTRUCTION_PATHS}
  </g>
</svg>`;

    const png = new Resvg(svg, { fitTo: { mode: 'width', value: size } })
        .render()
        .asPng();
    const path = join(outDir, `favicon-${size}.png`);
    writeFileSync(path, png);
    console.log(`wrote favicon-${size}.png (${png.length} bytes)`);
}

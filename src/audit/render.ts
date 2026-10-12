// The checks that need the ad rendered, read from what observe() saw in every frame and on every page.

import type { Box, Finding } from './types';

const TEXT_TAGS = new Set(['p', 'span', 'button']);

export function renderFindings(boxes: Box[]): Finding[] {
  const out: Finding[] = [];
  for (const b of boxes) {
    const where = { size: b.frame, ...(b.page ? { page: b.page } : {}), target: b.target };
    if (b.type) {
      const { fontSize, scale } = b.type;
      const px = Math.round(fontSize * scale * 100) / 100;
      if (px < 8 && (b.type.onScreen || b.type.moves)) {
        const hint = scale < 0.999
          ? `It is ${+fontSize.toFixed(2)}px scaled by ${scale.toFixed(2)}. Scale its group to at least ${(Math.ceil((8 / fontSize) * 100) / 100).toFixed(2)}, raise its font-size to ${Math.ceil(8 / scale)}px in this size, or hide it in this size.`
          : `Raise its font-size to at least 8px in this size, or hide it in this size.`;
        const hidden = b.type.hidden ? ' It is hidden right now, so this only matters if something shows it.' : '';
        out.push({ check: 'type', level: 'fail', ...where, message: `"${b.text}" renders at ${px.toFixed(2)}px.${hidden}`, hint });
      } else if (px < 8) {
        out.push({ check: 'type', level: 'note', ...where, message: `"${b.text}" is ${px.toFixed(2)}px but sits off-canvas and never moves, so it is never visible.` });
      }
    }
    if (!TEXT_TAGS.has(b.tag)) continue;
    if (!b.declared.lineHeight) {
      out.push({ check: 'lineHeight', level: 'fail', ...where, message: `No line-height (renders ${b.computed.lineHeight}).` });
    }
    if (b.tag === 'button') {
      if (b.computed.padding.some((v) => v !== 0)) {
        out.push({ check: 'buttonPadding', level: 'fail', ...where, message: `Padding is ${b.computed.paddingText}.` });
      }
      if (!b.declared.color) {
        out.push({ check: 'buttonColor', level: 'fail', ...where, message: `No explicit color (renders ${b.computed.color}).` });
      }
    } else if (b.declared.marginBlockStart !== '0px' || b.declared.marginBlockEnd !== 'auto') {
      out.push({ check: 'marginBlock', level: 'fail', ...where, message: 'Missing margin-block: 0px auto.' });
    }
  }
  return out;
}

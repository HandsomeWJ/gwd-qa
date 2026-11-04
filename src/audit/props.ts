// CSS property names as the checks compare them, wherever they were read: a rule, a keyframe, a
// script's style write or a browser's getKeyframes().

/** A property's name to compare by: no vendor prefix, hyphens or case ('-webkit-transform', 'webkitTransform' -> 'transform'). */
export const propKey = (p: string) => p.trim().replace(/^-(webkit|moz|ms|o)-/i, '').replace(/^(webkit|moz|ms|o)(?=[A-Z])/, '').replace(/-/g, '').toLowerCase();

/**
 * Properties (as propKey names them) that change neither where anything is nor how far it paints:
 * colours, opacity, visibility, stacking. An element outside the ad stays outside whatever they do.
 */
export const MOVES_NOTHING = /^(opacity|visibility|color|background(color|image)?|border(top|right|bottom|left)?color|outlinecolor|fill|stroke|stopcolor|caretcolor|textdecorationcolor|cursor|pointerevents|zindex|transition.*|mixblendmode|isolation|willchange)$/;

const NUMBER = /-?(?:\d+\.?\d*|\.\d+)(?:e[+-]?\d+)?/gi;

/**
 * Whether two computed values look the same to anyone: equal, or apart only by rounding, where every
 * number differs by at most 0.05 in px (a twentieth of a pixel) or 0.001 in anything else.
 */
export function looksSame(a: string | undefined, b: string | undefined): boolean {
  if (a === b) return true;
  if (a === undefined || b === undefined || a.replace(NUMBER, '#') !== b.replace(NUMBER, '#')) return false;
  const others = [...b.matchAll(NUMBER)];
  return [...a.matchAll(NUMBER)].every((m, i) => {
    const px = /^px/i.test(a.slice(m.index + m[0].length));
    return Math.abs(parseFloat(m[0]) - parseFloat(others[i][0])) <= (px ? 0.05 : 0.001);
  });
}

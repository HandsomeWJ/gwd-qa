// CSS property names as the checks compare them, wherever they were read: a rule, a keyframe, a
// script's style write or a browser's getKeyframes().

/** A property's name to compare by: no vendor prefix, hyphens or case ('-webkit-transform', 'webkitTransform' -> 'transform'). */
export const propKey = (p: string) => p.trim().replace(/^-(webkit|moz|ms|o)-/i, '').replace(/^(webkit|moz|ms|o)(?=[A-Z])/, '').replace(/-/g, '').toLowerCase();

/**
 * Properties (as propKey names them) that change neither where anything is nor how far it paints:
 * colours, opacity, visibility, stacking. An element outside the ad stays outside whatever they do.
 */
export const MOVES_NOTHING = /^(opacity|visibility|color|background(color|image)?|border(top|right|bottom|left)?color|outlinecolor|fill|stroke|stopcolor|caretcolor|textdecorationcolor|cursor|pointerevents|zindex|transition.*|mixblendmode|isolation|willchange)$/;

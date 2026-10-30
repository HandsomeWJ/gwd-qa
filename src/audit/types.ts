export type CheckId =
  | 'type'
  | 'lineHeight'
  | 'buttonPadding'
  | 'buttonColor'
  | 'marginBlock'
  | 'environment'
  | 'copy'
  | 'position'
  | 'textFade'
  | 'keyframes'
  | 'cssValues'
  | 'stackAdapt';

export interface CheckInfo {
  id: CheckId;
  title: string;
  passWhen: string;
}

// The QA checklist, in its original order.
export const CHECKS: CheckInfo[] = [
  { id: 'type', title: 'Type size', passWhen: 'Rendered text is at least 8px in every size, except disclaimers.' },
  { id: 'lineHeight', title: 'line-height', passWhen: 'Every <p>, <span> and <button> declares a line-height in every size.' },
  { id: 'buttonPadding', title: 'Button padding', passWhen: 'Every <button> has padding: 0px.' },
  { id: 'buttonColor', title: 'Button color', passWhen: 'Every <button> declares an explicit color.' },
  { id: 'marginBlock', title: 'margin-block', passWhen: 'Every <p> and <span> declares margin-block: 0px auto.' },
  { id: 'environment', title: 'Non-Google Ad', passWhen: 'The file was converted with File → Ad Environment → Non Google Ad → Convert.' },
  { id: 'copy', title: 'Copy', passWhen: 'No typos or grammar errors, in the base text or any size. Read the list yourself.' },
  { id: 'position', title: 'Position animation', passWhen: 'Keyframes move elements with transform: translate3d, never top or left.' },
  { id: 'textFade', title: 'Text fade-in', passWhen: 'Text that fades in starts at opacity 0.001, not 0.' },
  { id: 'keyframes', title: 'Keyframes', passWhen: 'Keyframes hold only properties that change between them.' },
  { id: 'cssValues', title: 'CSS values', passWhen: 'Every CSS value is valid, including styles that events and scripts set (opacity: 0.3, not 0,3).' },
  { id: 'stackAdapt', title: 'StackAdapt scripts', passWhen: "The ad loads StackAdapt's iframe-ct.js and param.js once each, param.js after every tap area (class dynamicClick)." },
];

export interface Finding {
  check: CheckId;
  level: 'fail' | 'note';
  size?: string; // frame label where it was seen; absent for source-level findings
  page?: string; // GWD page it is on, when the ad has more than one page
  target: string; // element or keyframes label
  message: string;
  hint?: string; // how to fix it by hand, for problems that are not fixed automatically
  unknown?: boolean; // a note where the check could not decide, so the user must look
}

/**
 * What the checks saw of one element, in one frame, on one page. Plain data: the rendered
 * checks and the fix planner read only this, never the frames.
 */
export interface Box {
  frame: string; // frame label
  size?: string; // served size key of the frame
  /** Made at runtime (e.g. a text effect's word spans): not in the HTML, so it cannot be edited. */
  runtime?: boolean;
  page: string; // GWD page id when the ad has more than one page, else ''
  target: string; // label(el)
  id: string;
  tag: string; // lower case
  classes: string[];
  text: string; // its text, whitespace collapsed, at most 40 characters
  /** Set for elements with their own text that render. */
  type?: { fontSize: number; scale: number; onScreen: boolean; moves: boolean; hidden: boolean };
  /** Values its own CSS declares (inline style or a rule that applies in this frame); '' when none. */
  declared: { lineHeight: string; color: string; width: string; height: string; marginBlockStart: string; marginBlockEnd: string };
  computed: {
    color: string;
    fontSize: number;
    fontFamily: string;
    lineHeight: string;
    padding: [number, number, number, number]; // top, right, bottom, left in px
    paddingText: string;
    textAlign: string;
    whiteSpace: string;
    display: string;
    position: string;
    marginTop: number;
    marginBottom: number;
  };
  /** The px a browser renders for line-height: normal in its font; set when no line-height is declared. */
  normalLineHeight?: number;
  /** False when its web font had not loaded, so normalLineHeight measured a fallback font. */
  fontLoaded?: boolean;
  /**
   * Under line-height: normal some of its characters draw in a fallback font with other metrics
   * (an emoji, a symbol, Chinese, Japanese or Korean type its own font lacks), so its lines need not
   * all be one height and no one value keeps them.
   */
  mixedFonts?: boolean;
  /** An animation on it or an element it sits in changes its font (or line-height) while the ad runs. */
  fontAnimated?: boolean;
  /**
   * An element with no text of its own that holds text, such as a group's <div>: here only for its
   * classes, whose line-height the texts inside would take.
   */
  holder?: boolean;
  /** A span inside other text (a p, button, link…), which takes that parent's line-height. */
  inTextParent: boolean;
  /** For such a span: the px line-height its text parent renders (normal resolved to px). */
  parentLineHeight?: number;
  /**
   * The texts inside it that take its line-height today (they declare none, or inherit, and so
   * does every element between), which a value given to it would reach.
   */
  inherits?: Inheritor[];
  /**
   * For a <p>, <span> or <button> with no line-height of its own: every @media block that does not
   * apply in this frame and sets a font property or line-height for it, an element it sits in, or
   * the font of a text inside it. Keyed by the block's start offset, its normal line-height there:
   * measured in its font with that block's font declarations applied, or null where that cannot be
   * done exactly (the block sets a line-height, a block that applies here already changes its font,
   * or which declaration wins is not plain).
   */
  probes?: Record<number, number | null>;
  /**
   * GWD's text helper fits this text (or the text it sits in) to its box when the ad runs:
   * 'runs' when GWD's text fitting ran in the preview, 'missing' when it could not (the stand-in
   * has no gwd-text-fitting.js), so the size measured is the size before fitting.
   */
  fit?: 'runs' | 'missing';
}

/** Text inside an element that takes that element's line-height. */
export interface Inheritor {
  target: string; // label(el)
  tag: string;
  /** Every element from just inside the element down to this text, itself included. */
  path: { tag: string; classes: string[] }[];
  /** The px line-height it renders now: what it inherits, or for line-height: normal its font's. */
  normal: number;
  fontLoaded: boolean;
  /** As on Box: an animation changes its font while the ad runs. */
  fontAnimated?: boolean;
}

export interface CopyItem {
  target: string;
  size: string; // 'base' or a served size
  text: string;
}

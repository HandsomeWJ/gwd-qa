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
  | 'keyframes';

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
];

export interface Finding {
  check: CheckId;
  level: 'fail' | 'note';
  size?: string; // frame label where it was seen; absent for source-level findings
  page?: string; // GWD page it is on, when the ad has more than one page
  target: string; // element or keyframes label
  message: string;
  hint?: string; // how to fix it by hand, for problems that are not fixed automatically
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
  /** A span inside other text (a p, button, link…), which takes that parent's line-height. */
  inTextParent: boolean;
  /** For such a span: the px line-height its text parent renders (normal resolved to px). */
  parentLineHeight?: number;
}

export interface CopyItem {
  target: string;
  size: string; // 'base' or a served size
  text: string;
}

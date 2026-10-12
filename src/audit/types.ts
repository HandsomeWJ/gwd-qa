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
  size?: string; // served size where it was seen; absent for source-level findings
  target: string; // element or keyframes label
  message: string;
  hint?: string; // how to fix it by hand, for problems that are not fixed automatically
}

export interface CopyItem {
  target: string;
  size: string; // 'base' or a served size
  text: string;
}

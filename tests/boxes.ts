import type { Box } from '../src/audit/types';

type BoxInput = Partial<Omit<Box, 'declared' | 'computed'>> & {
  declared?: Partial<Box['declared']>;
  computed?: Partial<Box['computed']>;
};

/** An observed element with neutral defaults: a positioned <p> that declares nothing. */
export function box(input: BoxInput = {}): Box {
  const { declared, computed, ...rest } = input;
  return {
    frame: '300x250',
    page: '',
    target: 'p',
    id: '',
    tag: 'p',
    classes: [],
    text: 'Text',
    inTextParent: false,
    ...rest,
    declared: { lineHeight: '', color: '', width: '', height: '', marginBlockStart: '0px', marginBlockEnd: 'auto', ...declared },
    computed: {
      color: 'rgb(0, 0, 0)',
      fontSize: 16,
      fontFamily: 'Arial',
      lineHeight: 'normal',
      padding: [0, 0, 0, 0],
      paddingText: '0px',
      textAlign: 'start',
      whiteSpace: 'normal',
      display: 'block',
      position: 'absolute',
      marginTop: 0,
      marginBottom: 0,
      ...computed,
    },
  };
}

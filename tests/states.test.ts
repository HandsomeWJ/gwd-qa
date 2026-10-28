import { describe, expect, it } from 'vitest';
import { parseCss } from '../src/css/parse';
import { describeStates, findStates, hasStates } from '../src/audit/states';

const page = (head: string, body = '') => `<!DOCTYPE html>
<html>
<head>
${head}
</head>
<body>
${body}
</body>
</html>
`;
const states = (html: string, files: Record<string, string> = {}) =>
  findStates(html, parseCss(html), { htmlPath: 'Ad/Responsive.html', files: new Map(Object.entries(files).map(([k, v]) => [k, new TextEncoder().encode(v)])) });

describe('findStates', () => {
  it('finds the rules that wait for a hover, focus or press and change a font or line-height', () => {
    const s = states(page(`  <style>
    .gwd-button-b:hover { font-size: 24px; }
    .gwd-button-c:hover { color: red; }
    .gwd-div-w:focus-within .gwd-p-t { line-height: 30px; }
    @media (width: 300px) and (height: 250px) {
      .gwd-p-a:active { font-weight: bold; }
    }
    .gwd-p-b:not(.x) { font-size: 12px; }
  </style>
  <link rel="stylesheet" href="extra.css">`), { 'Ad/extra.css': '.gwd-p-e:focus { font: 20px Arial; }' });
    expect(s.rules).toEqual(['.gwd-button-b:hover', '.gwd-div-w:focus-within .gwd-p-t', '.gwd-p-a:active', '.gwd-p-e:focus']);
    expect(hasStates(s)).toBe(true);
  });

  it('finds the fonts and line-heights scripts set, on the elements they name', () => {
    const s = states(page(`  <style>.gwd-p-a { font-size: 16px; }</style>
  <script type="text/javascript" gwd-events="handlers">
    gwd.auto_click = function(event) {
      gwd.actions.events.setInlineStyle('SA_cta_1', 'font-size: 20px; opacity: 0.5;');
      gwd.actions.events.setInlineStyle('card_1 title', 'line-height: 30px;');
      document.getElementById('SA_t_1').style.fontSize = '30px';
      document.querySelector('#SA_u_1').style.setProperty('font-weight', 'bold');
      document.getElementById('SA_v_1').style.color = 'red';
    };
  </script>`));
    expect(s.styles.map((x) => [x.ref, x.prop, x.value])).toEqual([
      ['SA_cta_1', 'font-size', '20px'],
      ['card_1 title', 'line-height', '30px'],
      ['SA_t_1', 'font-size', '30px'],
      ['SA_u_1', 'font-weight', 'bold'],
    ]);
    expect(s.styles[0].label).toBe('setInlineStyle on SA_cta_1 in gwd.auto_click');
    expect(s.unknown).toEqual([]);
  });

  it('finds the classes scripts put on or take off, where their rules change a font or run an animation', () => {
    const s = states(page(`  <style>
    .big { font-size: 30px; }
    .red { color: red; }
    .wrap.tall .gwd-p-a { line-height: 40px; }
    .grow { animation: grow 1s; }
  </style>
  <script>
    function go(el) {
      document.getElementById('SA_c_1').classList.add('big', 'red');
      document.querySelector('#SA_d_1').className += ' tall';
      document.getElementById('SA_e_1').classList.toggle('big', true);
      document.getElementById('SA_f_1').classList.replace('red', 'grow');
      document.getElementById('SA_g_1').setAttribute('class', 'gwd-p-a big');
      el.classList.add('big');
    }
  </script>`));
    expect(s.classes.map((c) => [c.ref, c.op, c.name])).toEqual([
      ['SA_c_1', 'add', 'big'],
      ['SA_d_1', 'add', 'tall'],
      ['SA_e_1', 'toggle', 'big'],
      ['SA_f_1', 'add', 'grow'],
      ['SA_g_1', 'add', 'gwd-p-a'], // a rule for .wrap.tall sets its line-height
      ['SA_g_1', 'add', 'big'],
      [null, 'add', 'big'],
    ]);
    expect(s.unknown).toEqual([]);
  });

  it('lists what scripts change on elements the code does not name', () => {
    const s = states(page(`  <style>.big { font-size: 30px; }</style>
  <script>
    function shrink(el) {
      el.style.fontSize = '10px';
      this.classList.remove('big');
      el.style.color = 'red';
    }
  </script>`));
    expect(s.unknown).toEqual(['style.fontSize on el in shrink sets font-size', 'classList.remove on this in shrink takes off big']);
    expect(hasStates(s)).toBe(false);
  });

  it('skips GWD\'s own runtime and an ad with no states', () => {
    const s = states(page(`  <style>.gwd-p-a { font-size: 16px; } .gwd-p-a:hover { color: blue; }</style>
  <script data-source="gwd-events-support.1.0.js">gwd.actions.events.setInlineStyle('x', 'font-size: 9px');</script>`));
    expect(s).toEqual({ rules: [], styles: [], classes: [], unknown: [], showers: { rules: [], keyframes: [], animators: [], scripts: [] } });
    expect(hasStates(s)).toBe(false);
  });

  it('lists what could show a hidden element: rules and keyframes that set visibility, and scripts that set it or change classes', () => {
    const s = states(page(`  <style>
    .gwd-div-a:hover { visibility: visible; }
    .gwd-div-b { visibility: hidden; }
    @keyframes kf-show { 0% { visibility: hidden; } 100% { visibility: visible; } }
    @keyframes kf-hide { 0% { visibility: hidden; } 100% { visibility: collapse; } }
    .gwd-play-animation .gwd-div-c { animation: 1s linear 0s 1 normal forwards kf-show; }
    .gwd-play-animation .gwd-div-d { animation: 1s linear 0s 1 normal forwards kf-hide; }
  </style>
  <script>
    gwd.auto_click = function(event) {
      gwd.actions.events.setInlineStyle('SA_show_1', 'visibility: visible;');
      gwd.actions.events.setInlineStyle('SA_hide_1', 'visibility: hidden;');
      document.getElementById('SA_class_1').classList.add('gwd-on');
      event.target.style.visibility = 'inherit';
    };
  </script>`));
    expect(s.showers).toEqual({
      rules: ['.gwd-div-a:hover'],
      keyframes: ['kf-show'],
      animators: ['.gwd-play-animation .gwd-div-c'],
      scripts: [
        { ref: 'SA_show_1', label: 'setInlineStyle on SA_show_1 in gwd.auto_click' },
        { ref: 'SA_class_1', label: 'classList.add on SA_class_1 in gwd.auto_click' },
        { ref: null, label: 'style.visibility on event.target in gwd.auto_click' },
      ],
    });
  });

  it('describes the states by their first two', () => {
    const s = states(page(`  <style>.a:hover { font-size: 2px; } .b:focus { font-size: 3px; } .c:active { font-size: 4px; }</style>`));
    expect(describeStates(s)).toBe('in its hover, focus or click state (.a:hover; .b:focus; and 1 more)');
  });
});

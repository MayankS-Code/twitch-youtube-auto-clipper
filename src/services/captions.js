// Turns Whisper word timestamps into one-line burned-in captions.
//
// Grouping rule (one line at a time):
//   - every word in the line is <= 2 letters  -> up to 3 words
//   - longest word in the line is 3 letters    -> up to 2 words
//   - any word with 4+ letters                 -> that word alone
// Each line stays on screen while its words are being spoken.

const FONT_NAME = 'Montserrat ExtraBold';

const letters = (w) => (w.match(/[\p{L}\p{N}]/gu) || []).length;
const clean = (w) => w.toLowerCase().replace(/[^\p{L}\p{N}'’\- ]+/gu, '').replace(/^['’-]+|['’-]+$/g, '').trim();

function capacityFor(maxLetters) {
  if (maxLetters <= 2) return 3;
  if (maxLetters === 3) return 2;
  return 1;
}

function groupWords(words) {
  const items = words
    .map(w => ({ ...w, text: clean(w.word) }))
    .filter(w => w.text && letters(w.text) > 0);

  const groups = [];
  let cur = [];
  const flush = () => { if (cur.length) groups.push(cur); cur = []; };

  for (const w of items) {
    const trial = [...cur, w];
    const maxLen = Math.max(...trial.map(x => letters(x.text)));
    // a long pause also starts a new line, so a line never spans a silence
    const gap = cur.length ? w.start - cur[cur.length - 1].end : 0;
    if (cur.length && (trial.length > capacityFor(maxLen) || gap > 0.6)) {
      flush();
      cur = [w];
    } else {
      cur = trial;
    }
  }
  flush();

  // timing: from first word start to last word end; bridge short gaps so it doesn't flicker
  const lines = groups.map(g => ({ text: g.map(x => x.text).join(' '), start: g[0].start, end: g[g.length - 1].end }));
  for (let i = 0; i < lines.length; i++) {
    const L = lines[i];
    const next = lines[i + 1];
    L.end = Math.max(L.end, L.start + 0.2);
    if (next && next.start - L.end < 0.4) L.end = next.start;
    if (next && L.end > next.start) L.end = next.start;
  }
  return lines.filter(l => l.end - l.start > 0.04);
}

function assTime(t) {
  t = Math.max(0, t);
  const h = Math.floor(t / 3600);
  const m = Math.floor((t % 3600) / 60);
  const s = Math.floor(t % 60);
  const cs = Math.floor((t - Math.floor(t)) * 100);
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

const assEscape = (s) => s.replace(/\\/g, '\\\\').replace(/\{/g, '(').replace(/\}/g, ')');

/**
 * @param lines   output of groupWords
 * @param opts    { x, y, fontSize, outW, outH }
 */
function buildAss(lines, opts) {
  const { x = 540, y = 1555, fontSize = 120, outW = 1080, outH = 1920 } = opts || {};
  const fontName = (opts && opts.fontName) || FONT_NAME;
  const bold = fontName === FONT_NAME ? 0 : -1;
  const header = [
    '[Script Info]',
    'ScriptType: v4.00+',
    `PlayResX: ${outW}`,
    `PlayResY: ${outH}`,
    'WrapStyle: 2',
    'ScaledBorderAndShadow: yes',
    '',
    '[V4+ Styles]',
    'Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding',
    // white text, thin 2px solid black outline, small soft drop shadow
    `Style: Cap,${fontName},${fontSize},&H00FFFFFF,&H00FFFFFF,&H00000000,&HA0000000,${bold},0,0,0,100,100,0,0,1,2,2,5,0,0,0,1`,
    '',
    '[Events]',
    'Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text'
  ];
  const events = lines.map(l =>
    `Dialogue: 0,${assTime(l.start)},${assTime(l.end)},Cap,,0,0,0,,{\\an5\\pos(${x},${y})}${assEscape(l.text)}`);
  return header.concat(events).join('\r\n') + '\r\n';
}

module.exports = { groupWords, buildAss, FONT_NAME, capacityFor };

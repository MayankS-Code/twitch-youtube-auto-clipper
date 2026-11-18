// Devanagari -> casual Roman Hinglish ("अब देखना" -> "ab dekhna"), with Hindi schwa deletion.

const CONS = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'n',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'n',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v', 'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f', 'य़': 'y'
};
const NUKTA_BASE = { 'क': 'क़', 'ख': 'ख़', 'ग': 'ग़', 'ज': 'ज़', 'ड': 'ड़', 'ढ': 'ढ़', 'फ': 'फ़', 'य': 'य़' };
const VOWELS = { 'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri', 'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au', 'ऑ': 'o', 'ॲ': 'e' };
const MATRAS = { 'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri', 'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au', 'ॉ': 'o', 'ॅ': 'e' };
const DIGITS = '०१२३४५६७८९';
const HALANT = '्';
const NUKTA = '़';
const NASAL = new Set(['ं', 'ँ']);

const isDeva = (s) => /[\u0900-\u097F]/.test(s);

function wordToRoman(word) {
  // 1) split into units: { type:'c', base, vowel: string|null (null = inherent a), halant } or { type:'v' } etc.
  const chars = [...word.normalize('NFC')];
  const units = [];
  for (let i = 0; i < chars.length; i++) {
    let ch = chars[i];
    if (chars[i + 1] === NUKTA && NUKTA_BASE[ch]) { ch = NUKTA_BASE[ch]; i++; }
    if (CONS[ch]) {
      units.push({ type: 'c', text: CONS[ch], vowel: null, halant: false, nasal: false });
    } else if (MATRAS[ch] && units.length && units[units.length - 1].type === 'c') {
      units[units.length - 1].vowel = MATRAS[ch];
    } else if (ch === HALANT && units.length && units[units.length - 1].type === 'c') {
      units[units.length - 1].halant = true;
    } else if (NASAL.has(ch) && units.length) {
      units[units.length - 1].nasal = true;
    } else if (VOWELS[ch]) {
      units.push({ type: 'v', text: VOWELS[ch], nasal: false });
    } else if (ch === 'ः') {
      units.push({ type: 'x', text: 'h' });
    } else if (DIGITS.includes(ch)) {
      units.push({ type: 'x', text: String(DIGITS.indexOf(ch)) });
    } else if (ch !== NUKTA && ch !== '\u200d' && ch !== '\u200c') {
      units.push({ type: 'x', text: ch });
    }
  }

  // 2) schwa deletion: a consonant's inherent "a" is dropped at the end of a word,
  //    and in the middle when it sits between a vowel and a consonant that carries a vowel
  const hasVowel = (u) => u && (u.type === 'v' || (u.type === 'c' && !u.halant && (u.vowel !== null || !u.dropA)));
  const consCount = units.filter(u => u.type === 'c').length;
  for (let i = units.length - 1; i >= 0; i--) {
    const u = units[i];
    if (u.type !== 'c' || u.halant || u.vowel !== null) continue;
    const isLast = i === units.length - 1;
    if (isLast) { u.dropA = consCount > 1 || units.length > 1; continue; }
    const prev = units[i - 1];
    const next = units[i + 1];
    const prevVoiced = prev && (prev.type === 'v' || (prev.type === 'c' && !prev.halant && !prev.dropA));
    const nextVoiced = next && next.type === 'c' && !next.halant && (next.vowel !== null || !next.dropA);
    if (i > 0 && prevVoiced && nextVoiced) u.dropA = true;
  }

  // 3) build string
  let out = '';
  for (let i = 0; i < units.length; i++) {
    const u = units[i];
    if (u.type === 'c') {
      out += u.text;
      if (!u.halant) {
        const v = u.vowel !== null ? u.vowel : (u.dropA ? '' : 'a');
        out += v;
        if (u.nasal) out += (u.vowel === 'e' ? 'in' : 'n');
      }
    } else {
      out += u.text;
      if (u.nasal) out += 'n';
    }
  }
  // tidy common spellings
  return out.replace(/aa$/, 'a').replace(/ee$/, 'i').replace(/ph/g, 'f');
}

function toHinglish(text) {
  return text.split(/(\s+)/).map(w => (isDeva(w) ? wordToRoman(w) : w)).join('');
}

module.exports = { toHinglish, isDeva };

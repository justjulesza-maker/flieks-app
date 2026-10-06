/**
 * A stand-in for the AI in schedule tests: answers the breakdown prompt in the
 * same JSON shape, from the scene text it is sent (cast = character cues).
 */
module.exports = function fakeBreakdownAI(body, extra = {}) {
  const user = String((body.messages && body.messages[0] && body.messages[0].content) || '');
  const parts = user.split(/^=== SCENE /m).slice(1);
  return JSON.stringify(parts.map(p => {
    const n = p.match(/^(\S+)/)[1];
    const lines = p.split('\n');
    const heading = lines[1] || '';
    const set = heading.replace(/^(INT\.?\/EXT\.?|EXT\.?\/INT\.?|I\/E\.?|INT\.?|EXT\.?)\s*/i, '').replace(/\s*[-–—]\s*(DAY|NIGHT|MORNING|EVENING|DUSK|DAWN|CONTINUOUS|LATER).*$/i, '').trim();
    const cast = [...new Set(lines.slice(2).filter(l => /^\s{10,}[A-Z][A-Z .'&-]{1,30}(\s*\(.*\))?\s*$/.test(l)).map(l => l.trim().replace(/\s*\(.*\)$/, '')))];
    return Object.assign({ n, set, loc: set.split(/\s[-–—]\s/)[0], area: '', ie: /^EXT/i.test(heading) ? 'EXT' : /\//.test(heading.split(' ')[0]) ? 'INT/EXT' : 'INT',
      dn: /NIGHT/i.test(heading) ? 'NIGHT' : 'DAY', cast, extras: '', props: [], notes: [], effort: 2, sday: '' }, extra[n] || {});
  }));
};

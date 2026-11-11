// Gate detection from STANDARDS.md receipt formats (ADR-0003 D6). Pure.
// Anchored, line-based parsing. No heuristics on free text.

const MAX_BLOCK_LINES = 16;

const PASS_VERDICTS = new Set(['APPROVED', 'DONE', 'PASS']);

export const GATE_OWNERS = Object.freeze({
  review: 'cavecrew-reviewer',
  dod: 'qa',
  security: 'security',
  ci: 'ci',
});

const HEADERS = [
  { gate: 'review', regex: /^(?:REVIEW RECEIPT|RECIBO DE REVISI[OÓ]N)$/i },
  { gate: 'dod', regex: /^DoD\s*[\u2014\u2013-]\s*(US-[0-9]{3,6})\b/ },
  { gate: 'security', regex: /^(?:SECURITY RECEIPT|RECIBO DE SEGURIDAD)$/i },
];

const VERDICT_LINE = /^(?:Veredicto|Verdict)\s*:\s*(APPROVED|CHANGES REQUESTED|BLOCKED)$/i;
const RESULT_LINE = /^(?:RESULTADO|RESULT)\s*:\s*(DONE|NOT DONE)$/i;
const FINDINGS_LINE = /^(?:Findings|Hallazgos)\s*:\s*\u{1F534}\uFE0F?\s*([0-9]+)\s*\|\s*\u{1F7E1}\uFE0F?\s*([0-9]+)\s*\|\s*\u{1F7E2}\uFE0F?\s*([0-9]+)$/u;
const RELEASE_LINE = /^(?:Release|Versi[oó]n)\s*:\s*(v?[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$/i;
const AUDIT_LINE = /^(?:Dependency audit|Auditor[ií]a de dependencias)\s*:\s*([0-9]+)\s*high\s*\/\s*([0-9]+)\s*critical$/i;
const STORY_ID = /\bUS-[0-9]{3,6}\b/;

const ALLOWED_VERDICTS = {
  review: new Set(['APPROVED', 'CHANGES REQUESTED']),
  dod: new Set(['DONE', 'NOT DONE']),
  security: new Set(['APPROVED', 'BLOCKED']),
};

/** Strip markdown decoration (#, >, *, _, `) and surrounding whitespace. */
function cleanLine(line) {
  return line
    .replace(/\*\*|__|`/g, '')
    .replace(/^[\s#>*_|-]*?(?=[A-Za-z\u{1F534}])/u, '')
    .replace(/[\s*_`]+$/u, '')
    .trim();
}

function headerOf(line) {
  for (const { gate, regex } of HEADERS) {
    const match = regex.exec(line);
    if (match) return { gate, story_id: gate === 'dod' ? match[1] : undefined };
  }
  return undefined;
}

function toInt(value) {
  const number = Number.parseInt(value, 10);
  return Number.isSafeInteger(number) ? number : undefined;
}

function parseBlock(header, lines) {
  const gate = { gate: header.gate };
  let rawVerdict;
  for (const line of lines) {
    const verdict = header.gate === 'dod' ? RESULT_LINE.exec(line) : VERDICT_LINE.exec(line);
    if (verdict) rawVerdict = verdict[1].toUpperCase().replace(/\s+/g, ' ');
    if (header.gate === 'review') {
      const findings = FINDINGS_LINE.exec(line);
      if (findings) {
        gate.counts = { blocking: toInt(findings[1]), warning: toInt(findings[2]), nit: toInt(findings[3]) };
      }
      const story = STORY_ID.exec(line);
      if (story && !gate.story_id) gate.story_id = story[0];
    }
    if (header.gate === 'security') {
      const release = RELEASE_LINE.exec(line);
      if (release) gate.release = release[1];
      const audit = AUDIT_LINE.exec(line);
      if (audit) gate.counts = { high: toInt(audit[1]), critical: toInt(audit[2]) };
    }
  }
  if (header.story_id) gate.story_id = header.story_id;
  if (!rawVerdict || !ALLOWED_VERDICTS[header.gate].has(rawVerdict)) return undefined;
  gate.raw_verdict = rawVerdict;
  gate.verdict = PASS_VERDICTS.has(rawVerdict) ? 'pass' : 'fail';
  gate.owner = GATE_OWNERS[header.gate];
  return gate;
}

/**
 * @param {string} text
 * @returns {{gates: Array<{gate:string, verdict:'pass'|'fail', raw_verdict:string,
 *   counts?:object, story_id?:string, release?:string, owner:string}>, notes: string[]}}
 */
export function detectGates(text) {
  const result = { gates: [], notes: [] };
  if (typeof text !== 'string' || text.length === 0) return result;
  const lines = text.replace(/\r\n?/g, '\n').split('\n').map(cleanLine);
  for (let index = 0; index < lines.length; index += 1) {
    const header = headerOf(lines[index]);
    if (!header) continue;
    const block = [];
    let cursor = index + 1;
    while (cursor < lines.length && block.length < MAX_BLOCK_LINES) {
      const line = lines[cursor];
      if (line === '' || headerOf(line)) break;
      block.push(line);
      cursor += 1;
    }
    const gate = parseBlock(header, block);
    if (gate) result.gates.push(gate);
    else result.notes.push(`receipt_without_verdict:${header.gate}`);
    index = cursor - 1;
  }
  return result;
}

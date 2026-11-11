// Transcript tail reader (ADR-0003 D5): last assistant text from the final
// 64 KB of a Claude Code JSONL transcript. Read-only, never modifies the file.
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { isAbsolute } from 'node:path';

export const MAX_TAIL_BYTES = 64 * 1024;
const HANDBACK_TOOL = 'SubagentHandback';

export function readTail(path, maxBytes = MAX_TAIL_BYTES) {
  if (typeof path !== 'string' || !isAbsolute(path)) return '';
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return '';
    const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const size = fstatSync(fd).size;
      const length = Math.min(size, maxBytes);
      const buffer = Buffer.alloc(length);
      let total = 0;
      while (total < length) {
        const bytes = readSync(fd, buffer, total, length - total, size - length + total);
        if (bytes === 0) break;
        total += bytes;
      }
      return buffer.subarray(0, total).toString('utf8');
    } finally {
      closeSync(fd);
    }
  } catch {
    return '';
  }
}

function contentBlocks(entry) {
  const message = entry && typeof entry === 'object' ? entry.message : undefined;
  if (!message || message.role !== 'assistant') return [];
  if (typeof message.content === 'string') return [{ type: 'text', text: message.content }];
  return Array.isArray(message.content) ? message.content : [];
}

/**
 * Parse a transcript tail. Returns the last SubagentHandback report (current
 * Claude Code delivers subagent reports through that tool) and the last
 * assistant text block.
 * @returns {{handback?: string, lastText?: string}}
 */
export function extractFromTranscript(tailText) {
  const result = {};
  if (typeof tailText !== 'string' || tailText.length === 0) return result;
  const lines = tailText.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (result.handback !== undefined && result.lastText !== undefined) break;
    let entry;
    try {
      entry = JSON.parse(lines[index]);
    } catch {
      continue;
    }
    const blocks = contentBlocks(entry);
    for (let blockIndex = blocks.length - 1; blockIndex >= 0; blockIndex -= 1) {
      const block = blocks[blockIndex];
      if (!block || typeof block !== 'object') continue;
      if (result.handback === undefined && block.type === 'tool_use' && block.name === HANDBACK_TOOL
        && typeof block.input?.message === 'string') {
        result.handback = block.input.message;
      }
      if (result.lastText === undefined && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        result.lastText = block.text;
      }
    }
  }
  return result;
}

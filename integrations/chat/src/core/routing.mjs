// Verbosity filter and channel routing (ADR-0003 D10). Pure.

export const VERBOSITY_LEVELS = Object.freeze(['minimal', 'default', 'verbose']);

/** True for the per-turn PM agent.finished emitted from Stop (verbose only). */
export function isPmTurnFinished(event) {
  return event.type === 'agent.finished' && event.source?.hook === 'Stop';
}

/**
 * @param {object} event event.v1
 * @param {'minimal'|'default'|'verbose'} verbosity
 */
export function shouldSend(event, verbosity) {
  if (verbosity === 'minimal') return event.type === 'gate.result';
  if (verbosity === 'verbose') return true;
  return !isPmTurnFinished(event);
}

/** channels[type] if mapped, otherwise default_channel. */
export function routeChannel(event, config) {
  const channels = config.channels ?? {};
  return Object.hasOwn(channels, event.type) ? channels[event.type] : config.default_channel;
}

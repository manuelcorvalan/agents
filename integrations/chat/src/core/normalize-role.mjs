// Role normalization (ADR-0003 D5): aliases, then roles, otherwise "unknown".
export const UNKNOWN_ROLE = 'unknown';

/**
 * @param {unknown} raw native agent name (e.g. tool_input.subagent_type, agent_type)
 * @param {{aliases: Record<string,string>, roles: Record<string,object>}} identities
 * @returns {string} a key that exists in identities.roles
 */
export function normalizeRole(raw, identities) {
  if (typeof raw !== 'string') return UNKNOWN_ROLE;
  let candidate = raw.trim().toLowerCase();
  // Plugin agents are reported as "plugin:agent"; keep the agent part.
  const colon = candidate.lastIndexOf(':');
  if (colon >= 0) candidate = candidate.slice(colon + 1);
  if (candidate.length === 0 || candidate.length > 40) return UNKNOWN_ROLE;
  if (Object.hasOwn(identities.aliases, candidate)) {
    const target = identities.aliases[candidate];
    return Object.hasOwn(identities.roles, target) ? target : UNKNOWN_ROLE;
  }
  if (Object.hasOwn(identities.roles, candidate)) return candidate;
  return UNKNOWN_ROLE;
}

/**
 * Resolve the posting identity for a role: display name + fixed suffix, emoji.
 */
export function resolveIdentity(role, identities) {
  const entry = identities.roles[role] ?? identities.roles[UNKNOWN_ROLE] ?? identities.default;
  const identity = {
    username: `${entry.display_name}${identities.suffix}`,
    icon_emoji: entry.icon_emoji,
  };
  if (entry.color) identity.color = entry.color;
  return identity;
}

export function displayNameOf(role, identities) {
  const entry = identities.roles[role] ?? identities.roles[UNKNOWN_ROLE] ?? identities.default;
  return entry.display_name;
}

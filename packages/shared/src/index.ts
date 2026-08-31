export const MCP_SERVER_NAME = 'stma';
export const MCP_SERVER_VERSION = '0.1.0';

/** Personal access tokens look like `stma_<40 hex chars>`. */
export const PAT_PREFIX = 'stma_';

export const MESSAGE_KINDS = [
  'question',
  'answer',
  'hypothesis',
  'info-request',
  'resolution',
  'note',
  'announcement',
  'handoff',
] as const;
export type MessageKind = (typeof MESSAGE_KINDS)[number];

/** Bumped when the onboard_repo rules text changes meaningfully. */
export const ONBOARD_RULES_VERSION = 2;

export * from './snapshot';
export * from './compare';
export * from './agents';
export * from './conflicts';
export * from './policy';
export * from './readiness';
export * from './fingerprint';
export * from './delivery';

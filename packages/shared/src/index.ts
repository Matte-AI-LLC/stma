export const MCP_SERVER_NAME = 'stma';

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

/**
 * The kinds a person or an agent may write into a thread themselves.
 *
 * `announcement` and `handoff` are records the product writes through their own
 * tools (`announce`, `handoff_work`, `assign_work`), and the rest of the product
 * reads them as exactly that: a thread whose message is `handoff` is work
 * waiting for somebody, announced in their inbox and by their prompt hook. Until
 * 2026-09-21 `open_session` and the browser form accepted either, so any member
 * could mint a "handoff" with a title of their choosing, outside the monthly
 * allowance, the credential-step filter and the request receipt — and that title
 * reached every teammate's `stma watch` unprefixed, which is how the audit
 * turned it into code execution on a Mac.
 */
export const THREAD_MESSAGE_KINDS = [
  'question',
  'answer',
  'hypothesis',
  'info-request',
  'resolution',
  'note',
] as const satisfies readonly MessageKind[];
export type ThreadMessageKind = (typeof THREAD_MESSAGE_KINDS)[number];
export const isThreadMessageKind = (kind: unknown): kind is ThreadMessageKind =>
  typeof kind === 'string' && (THREAD_MESSAGE_KINDS as readonly string[]).includes(kind);

/** Bumped when the onboard_repo rules text changes meaningfully. */
export const ONBOARD_RULES_VERSION = 2;

export * from './snapshot';
export * from './compare';
export * from './agents';
export * from './conflicts';
export * from './policy';
export * from './contentRules';
export * from './readiness';
export * from './fingerprint';
export * from './delivery';
export * from './knowledge';
export * from './checkpoints';

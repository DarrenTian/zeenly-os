/** A call the tree can't take; the message says why, for the agent or page. */
export class TreeError extends Error {}

/** The actor may not do this; the message says who may. */
export class Forbidden extends TreeError {}

/**
 * The database hasn't had every migration this code needs, so nothing may
 * be written until it has; reading carries on.
 */
export class SchemaBehind extends TreeError {}

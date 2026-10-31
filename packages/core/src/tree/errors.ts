/** A call the tree can't take; the message says why, for the agent or page. */
export class TreeError extends Error {}

/** The actor may not do this; the message says who may. */
export class Forbidden extends TreeError {}

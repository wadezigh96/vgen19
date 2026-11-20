/**
 * Agent-wide constants. Kept in their own module so both the CLI and
 * the Delphi adapter can use them without a circular import.
 */

/** Registered competitor name, shown on the leaderboard. */
export const AGENT_NAME = "Vgen19";

/**
 * The harness identifier sent with Delphi requests: the Vgen19
 * codebase itself is the program that runs the agent.
 */
export const HARNESS = "vgen19";

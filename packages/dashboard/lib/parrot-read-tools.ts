// The names of the parrot's read-only Dashboard tools. Kept free of imports so the live reducer (and backend
// tests that load it) do not pull in browser code.
export const READ_TOOL_NAMES = ["get_run_status", "explain_wallet", "get_backtest"] as const;
export type ReadToolName = (typeof READ_TOOL_NAMES)[number];
export const isReadTool = (name: unknown): name is ReadToolName => READ_TOOL_NAMES.includes(name as ReadToolName);

// Voice confirmation tools: request a summary and dry-run sketch, then confirm only after the visitor said yes.
export const CONFIRM_TOOL_NAMES = ["request_confirmation", "confirm_request"] as const;
export type ConfirmToolName = (typeof CONFIRM_TOOL_NAMES)[number];
export const isConfirmTool = (name: unknown): name is ConfirmToolName => CONFIRM_TOOL_NAMES.includes(name as ConfirmToolName);

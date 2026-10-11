import { ZodError } from 'zod';
export class WaypostError extends Error {
  constructor(readonly code: string, message: string, readonly details?: Record<string, unknown>) { super(message); this.name = 'WaypostError'; }
}
export type PublicError = { code: string; message: string; issues?: { path: string; message: string }[]; [key: string]: unknown };
// Schema issue messages are static text from Waypost or Zod; they never echo input values.
export function inputIssues(error: ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 10).map(issue => ({ path: issue.path.map(String).join('.') || '(input)', message: issue.message.slice(0, 300) }));
}
export function publicError(error: unknown): PublicError {
  if (error instanceof ZodError) {
    const issues = inputIssues(error);
    return { code: 'INPUT_INVALID', message: `Invalid arguments: ${issues.map(issue => `${issue.path}: ${issue.message}`).join('; ')}. Run waypost tools to see the input schema.`, issues };
  }
  if (error instanceof WaypostError) return { code: error.code, message: error.message, ...(error.details ?? {}) };
  return { code: 'OPERATION_FAILED', message: 'The operation failed. Check your configuration and the service connection with waypost doctor.' };
}

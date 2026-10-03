import { ZodError } from 'zod';
export class WaypostError extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'WaypostError'; }
}
export function publicError(error: unknown): { code: string; message: string } {
  if (error instanceof ZodError) return {code:'INPUT_INVALID',message:'Invalid arguments. Run waypost tools to see the required input schema.'};
  if (error instanceof WaypostError) return { code: error.code, message: error.message };
  return { code: 'OPERATION_FAILED', message: 'The operation failed. Check your configuration and the service connection with waypost doctor.' };
}

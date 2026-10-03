import { z } from 'zod';
import type { Config } from './config.js';

export interface Tool {
  name:string;
  title:string;
  description:string;
  schema:z.ZodType;
  readOnly:boolean;
  destructive:boolean;
  call:(config:Config,input:unknown)=>Promise<unknown>;
}
export function defineTool<S extends z.ZodType>(definition:{name:string;title:string;description:string;schema:S;readOnly:boolean;destructive:boolean;handler:(config:Config,input:z.output<S>)=>Promise<unknown>}):Tool {
  const {handler,...metadata}=definition;
  return {...metadata,call:(config,input)=>handler(config,definition.schema.parse(input))};
}

import { WaypostError } from './errors.js';

/**
 * A read-only Sieve evaluator for explaining what a user's filter would do to one message.
 * It covers the commands Proton documents (fileinto, addflag/setflag/removeflag, keep, stop,
 * discard) and the common tests (header, address, exists, size, allof/anyof/not, true/false).
 * Anything else is reported as unsupported and treated as false, so an explanation never
 * claims more than the evaluator knows. It never changes mail.
 */
type Token = {type:'word' | 'tag' | 'string' | 'number' | 'punct'; value:string};
export type SieveMessage = {headers:Map<string, string[]>; addresses:Map<string, string[]>; size:number};
export type SieveAction = {action:'fileinto' | 'addflag' | 'setflag' | 'removeflag' | 'keep' | 'discard' | 'redirect' | 'vacation'; value?:string[]};
export type SieveResult = {actions:SieveAction[]; flags:string[]; folders:string[]; implicitKeep:boolean; stopped:boolean; matched:string[]; unsupported:string[]};

const MAX_SCRIPT = 64 * 1024, MAX_STEPS = 20000;
function tokenize(script:string):Token[] {
  if (script.length > MAX_SCRIPT) throw new WaypostError('SIEVE_INVALID', 'The Sieve script is larger than 64 KiB.');
  const tokens:Token[] = [];
  let i = 0;
  while (i < script.length) {
    const c = script[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '#') { while (i < script.length && script[i] !== '\n') i++; continue; }
    if (script.startsWith('/*', i)) { const end = script.indexOf('*/', i + 2); if (end < 0) throw new WaypostError('SIEVE_INVALID', 'Unclosed comment in the Sieve script.'); i = end + 2; continue; }
    if (c === '"') {
      let value = ''; i++;
      while (i < script.length && script[i] !== '"') { if (script[i] === '\\' && i + 1 < script.length) i++; value += script[i]; i++; }
      if (i >= script.length) throw new WaypostError('SIEVE_INVALID', 'Unclosed string in the Sieve script.');
      i++; tokens.push({type:'string', value}); continue;
    }
    if (script.startsWith('text:', i)) {
      const start = script.indexOf('\n', i); const end = script.indexOf('\n.\n', start);
      if (start < 0 || end < 0) throw new WaypostError('SIEVE_INVALID', 'Unclosed multi-line text in the Sieve script.');
      tokens.push({type:'string', value:script.slice(start + 1, end)}); i = end + 3; continue;
    }
    if (c === ':') { const match = /^:[A-Za-z_][\w-]*/.exec(script.slice(i)); if (!match) throw new WaypostError('SIEVE_INVALID', 'Invalid tag in the Sieve script.'); tokens.push({type:'tag', value:match[0].toLowerCase()}); i += match[0].length; continue; }
    if (/\d/.test(c)) { const match = /^\d+[KMGkmg]?/.exec(script.slice(i))!; tokens.push({type:'number', value:match[0]}); i += match[0].length; continue; }
    if (/[A-Za-z_]/.test(c)) { const match = /^[A-Za-z_][\w.-]*/.exec(script.slice(i))!; tokens.push({type:'word', value:match[0].toLowerCase()}); i += match[0].length; continue; }
    if ('[](){},;'.includes(c)) { tokens.push({type:'punct', value:c}); i++; continue; }
    throw new WaypostError('SIEVE_INVALID', `Unexpected character in the Sieve script near position ${i}.`);
  }
  return tokens;
}
type Test = {name:string; tags:string[]; args:(string[] | number)[]; tests:Test[]};
type Command = {name:string; tags:string[]; args:(string[] | number)[]; test?:Test; block?:Command[]; branches?:{test:Test | null; block:Command[]}[]};
function parse(tokens:Token[]):Command[] {
  let i = 0;
  const peek = () => tokens[i];
  const expect = (value:string) => { const token = tokens[i++]; if (!token || token.value !== value) throw new WaypostError('SIEVE_INVALID', `Sieve syntax error: expected "${value}".`); };
  const stringList = ():string[] => {
    const token = peek();
    if (token?.type === 'string') { i++; return [token.value]; }
    if (token?.value !== '[') throw new WaypostError('SIEVE_INVALID', 'Sieve syntax error: expected a string or list.');
    i++; const values:string[] = [];
    while (peek()?.value !== ']') { const item = tokens[i++]; if (item?.type !== 'string') throw new WaypostError('SIEVE_INVALID', 'Sieve syntax error in a string list.'); values.push(item.value); if (peek()?.value === ',') i++; }
    i++; return values;
  };
  const number = (value:string) => Number(value.replace(/[KMG]$/i, '')) * ({k:1024, m:1048576, g:1073741824}[value.slice(-1).toLowerCase()] ?? 1);
  const argumentsOf = () => {
    const tags:string[] = [], args:(string[] | number)[] = [];
    for (;;) {
      const token = peek();
      if (token?.type === 'tag') { tags.push(token.value); i++; }
      else if (token?.type === 'number') { args.push(number(token.value)); i++; }
      else if (token?.type === 'string' || token?.value === '[') args.push(stringList());
      else return {tags, args};
    }
  };
  const test = ():Test => {
    const name = tokens[i++];
    if (name?.type !== 'word') throw new WaypostError('SIEVE_INVALID', 'Sieve syntax error: expected a test.');
    if (name.value === 'not') return {name:'not', tags:[], args:[], tests:[test()]};
    if (name.value === 'allof' || name.value === 'anyof') {
      expect('('); const tests:Test[] = [test()];
      while (peek()?.value === ',') { i++; tests.push(test()); }
      expect(')'); return {name:name.value, tags:[], args:[], tests};
    }
    return {name:name.value, ...argumentsOf(), tests:[]};
  };
  const block = ():Command[] => { expect('{'); const commands = list('}'); expect('}'); return commands; };
  const list = (end?:string):Command[] => {
    const commands:Command[] = [];
    while (i < tokens.length && peek()?.value !== end) {
      const name = tokens[i++];
      if (name?.type !== 'word') throw new WaypostError('SIEVE_INVALID', 'Sieve syntax error: expected a command.');
      if (name.value === 'if') {
        const branches = [{test:test() as Test | null, block:block()}];
        while (peek()?.value === 'elsif') { i++; branches.push({test:test(), block:block()}); }
        if (peek()?.value === 'else') { i++; branches.push({test:null, block:block()}); }
        commands.push({name:'if', tags:[], args:[], branches});
        continue;
      }
      const parsed = argumentsOf();
      expect(';');
      commands.push({name:name.value, ...parsed});
    }
    return commands;
  };
  return list();
}
const casemap = (value:string) => value.toLowerCase();
/** RFC 5228 :matches with * and ?, case-insensitive, in linear time (no regular expression, so no backtracking). */
export function wildcard(pattern:string, value:string):boolean {
  const p = pattern.toLowerCase(), v = value.toLowerCase();
  let i = 0, j = 0, star = -1, mark = 0;
  while (j < v.length) {
    if (i < p.length && (p[i] === '?' || p[i] === v[j])) { i++; j++; }
    else if (i < p.length && p[i] === '*') { star = i++; mark = j; }
    else if (star >= 0) { i = star + 1; j = ++mark; }
    else return false;
  }
  while (i < p.length && p[i] === '*') i++;
  return i === p.length;
}
function compare(values:string[], keys:string[], tags:string[], unsupported:Set<string>):boolean {
  const caseSensitive = false;
  // A user's :regex could backtrack for minutes on a hostile header, so it is reported, not run.
  if (tags.includes(':regex')) { unsupported.add(':regex matching'); return false; }
  if (tags.includes(':value') || tags.includes(':count')) { unsupported.add('relational comparisons'); return false; }
  const norm = caseSensitive ? (value:string) => value : casemap;
  if (tags.includes(':contains')) return values.some(value => keys.some(key => norm(value).includes(norm(key))));
  if (tags.includes(':matches')) return values.some(value => keys.some(key => wildcard(key, value)));
  return values.some(value => keys.some(key => norm(value) === norm(key)));
}
function addressPart(address:string, tags:string[]) {
  const at = address.lastIndexOf('@');
  if (tags.includes(':localpart')) return at < 0 ? address : address.slice(0, at);
  if (tags.includes(':domain')) return at < 0 ? '' : address.slice(at + 1);
  return address;
}
// Deeply nested tests recurse; report a typed error instead of a stack overflow.
const bounded = <T>(operation:()=>T):T => { try { return operation(); } catch (error) { if (error instanceof RangeError) throw new WaypostError('SIEVE_LIMIT', 'The Sieve script is nested too deeply to evaluate.'); throw error; } };
export function evaluateSieve(script:string, message:SieveMessage):SieveResult {
  const program = bounded(() => parse(tokenize(script)));
  const result:SieveResult = {actions:[], flags:[], folders:[], implicitKeep:true, stopped:false, matched:[], unsupported:[]};
  const unsupported = new Set<string>();
  let steps = 0;
  const strings = (value:string[] | number | undefined) => Array.isArray(value) ? value : [];
  const describe = (test:Test):string => test.tests.length ? `${test.name}(${test.tests.map(describe).join(', ')})` : `${test.name} ${test.tags.join(' ')} ${test.args.map(arg => Array.isArray(arg) ? JSON.stringify(arg.length === 1 ? arg[0] : arg) : String(arg)).join(' ')}`.replace(/\s+/g, ' ').trim();
  const run = (test:Test):boolean => {
    if (++steps > MAX_STEPS) throw new WaypostError('SIEVE_LIMIT', 'The Sieve script is too complex to evaluate.');
    switch (test.name) {
      case 'true': return true;
      case 'false': return false;
      case 'not': return !run(test.tests[0]!);
      case 'allof': return test.tests.every(run);
      case 'anyof': return test.tests.some(run);
      case 'exists': return strings(test.args[0]).every(name => (message.headers.get(name.toLowerCase()) ?? []).length > 0);
      case 'size': { const limit = test.args.find(arg => typeof arg === 'number'); if (typeof limit !== 'number') return false; return test.tags.includes(':over') ? message.size > limit : message.size < limit; }
      case 'header': { const values = strings(test.args[0]).flatMap(name => message.headers.get(name.toLowerCase()) ?? []); return compare(values, strings(test.args[1]), test.tags, unsupported); }
      case 'address': { const values = strings(test.args[0]).flatMap(name => message.addresses.get(name.toLowerCase()) ?? []).map(address => addressPart(address, test.tags)); return compare(values, strings(test.args[1]), test.tags, unsupported); }
      default: unsupported.add(`test "${test.name}"`); return false;
    }
  };
  const execute = (commands:Command[]):boolean => {
    for (const command of commands) {
      if (++steps > MAX_STEPS) throw new WaypostError('SIEVE_LIMIT', 'The Sieve script is too complex to evaluate.');
      switch (command.name) {
        case 'require': break;
        case 'if': for (const branch of command.branches ?? []) { if (!branch.test || run(branch.test)) { if (branch.test) result.matched.push(describe(branch.test)); if (!execute(branch.block)) return false; break; } } break;
        case 'stop': case 'return': result.stopped = true; return false;
        case 'keep': result.actions.push({action:'keep'}); break;
        case 'discard': result.actions.push({action:'discard'}); result.implicitKeep = false; break;
        case 'fileinto': { const target = strings(command.args[command.args.length - 1]); result.actions.push({action:'fileinto', value:target}); result.folders.push(...target); if (!command.tags.includes(':copy')) result.implicitKeep = false; break; }
        case 'addflag': case 'setflag': case 'removeflag': {
          const flags = strings(command.args[command.args.length - 1]).flatMap(value => value.split(/\s+/)).filter(Boolean);
          result.actions.push({action:command.name, value:flags});
          if (command.name === 'setflag') result.flags = [...flags];
          else if (command.name === 'addflag') result.flags = [...new Set([...result.flags, ...flags])];
          else result.flags = result.flags.filter(flag => !flags.includes(flag));
          break;
        }
        case 'redirect': case 'vacation': result.actions.push({action:command.name}); break;
        default: unsupported.add(`command "${command.name}"`);
      }
    }
    return true;
  };
  bounded(() => execute(program));
  result.unsupported = [...unsupported];
  return result;
}

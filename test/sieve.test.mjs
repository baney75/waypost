import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateSieve } from '../dist/sieve.js';

const script = `require ["fileinto","imap4flags","spamtest","environment","relational","comparator-i;ascii-numeric"];
# Proton's spam preamble: skip filters for spam.
if allof (environment :matches "vnd.proton.spam-threshold" "*", spamtest :value "ge" :comparator "i;ascii-numeric" "\${1}") {
  return;
}
/* urgent mail gets starred */
if header :contains "subject" "urgent" {
  addflag "\\\\Flagged";
}
if address :domain :is "from" "school.example" {
  addflag ["\\\\Flagged", "\\\\Seen"];
}
if anyof (exists "list-unsubscribe", header :contains "x-newsletter" "yes") {
  fileinto "Read Later";
} else {
  keep;
}
`;
const message = (headers, addresses, size = 1200) => ({
  headers: new Map(Object.entries(headers).map(([key, value]) => [key, [value].flat()])),
  addresses: new Map(Object.entries(addresses).map(([key, value]) => [key, [value].flat()])),
  size,
});

test('urgent subject is starred and kept; the spam preamble is reported unsupported, not guessed', () => {
  const result = evaluateSieve(script, message({subject: 'URGENT: sign this'}, {from: 'boss@work.example'}));
  assert.deepEqual(result.flags, ['\\Flagged']);
  assert.deepEqual(result.folders, []);
  assert.equal(result.implicitKeep, true);
  assert.equal(result.stopped, false);
  assert.ok(result.actions.some(action => action.action === 'keep'));
  assert.equal(result.matched.length, 1);
  assert.match(result.matched[0], /^header :contains/);
  assert.deepEqual(result.unsupported, ['test "environment"']);
});

test('school domain gets both flags and a newsletter header files into Read Later', () => {
  const result = evaluateSieve(script, message({subject: 'Newsletter', 'list-unsubscribe': '<mailto:u@school.example>'}, {from: 'office@school.example'}));
  assert.deepEqual(result.flags, ['\\Flagged', '\\Seen']);
  assert.deepEqual(result.folders, ['Read Later']);
  assert.equal(result.implicitKeep, false);
  assert.equal(result.matched.length, 2);
  assert.ok(!result.actions.some(action => action.action === 'keep'));
});

test('a message that matches nothing keeps implicitly and flags nothing', () => {
  const result = evaluateSieve(script, message({subject: 'Lunch?'}, {from: 'friend@home.example'}));
  assert.deepEqual(result.flags, []);
  assert.deepEqual(result.folders, []);
  assert.deepEqual(result.matched, []);
  assert.equal(result.implicitKeep, true);
  assert.deepEqual(result.actions, [{action: 'keep'}]);
});

test('stop, discard, :copy, setflag/removeflag, size and not behave', () => {
  const stopped = evaluateSieve('if true { stop; } keep;', message({}, {}));
  assert.equal(stopped.stopped, true);
  assert.deepEqual(stopped.actions, []);
  const discarded = evaluateSieve('discard;', message({}, {}));
  assert.equal(discarded.implicitKeep, false);
  const copied = evaluateSieve('fileinto :copy "Archive";', message({}, {}));
  assert.deepEqual(copied.folders, ['Archive']);
  assert.equal(copied.implicitKeep, true);
  const flags = evaluateSieve('addflag "\\\\Seen \\\\Flagged"; removeflag "\\\\Seen"; if size :over 1K { addflag "big"; } if not size :over 1M { addflag "small"; }', message({}, {}, 2048));
  assert.deepEqual(flags.flags, ['\\Flagged', 'big', 'small']);
  assert.deepEqual(evaluateSieve('setflag "a"; setflag "b";', message({}, {})).flags, ['b']);
});

test('matches globs, regex and unsupported relational tests are explicit', () => {
  const msg = message({subject: 'Invoice 2026-10'}, {from: 'billing@shop.example'});
  assert.deepEqual(evaluateSieve('if header :matches "subject" "Invoice*" { fileinto "Receipts"; }', msg).folders, ['Receipts']);
  // :regex could backtrack for minutes on a hostile header, so it is reported as unsupported, never run.
  const regex = evaluateSieve('if header :regex "subject" "^invoice \\\\d{4}" { fileinto "Receipts"; }', msg);
  assert.deepEqual(regex.folders, []);
  assert.ok(regex.unsupported.includes(':regex matching'));
  assert.deepEqual(evaluateSieve('if address :localpart :is "from" "billing" { fileinto "Receipts"; }', msg).folders, ['Receipts']);
  const relational = evaluateSieve('if header :count "ge" "subject" "1" { fileinto "X"; }', msg);
  assert.deepEqual(relational.folders, []);
  assert.deepEqual(relational.unsupported, ['relational comparisons']);
  const other = evaluateSieve('vacation "away"; reject "no";', msg);
  assert.deepEqual(other.unsupported, ['command "reject"']);
  assert.equal(other.actions[0].action, 'vacation');
});

test('parse errors and runaway scripts raise typed errors', () => {
  for (const bad of ['fileinto "x"', 'if true { keep;', 'keep; /* open', 'fileinto "open;', 'keep; @', 'if { keep; }', 'addflag [ "a" ;']) {
    assert.throws(() => evaluateSieve(bad, message({}, {})), {code: 'SIEVE_INVALID'}, bad);
  }
  assert.throws(() => evaluateSieve('#'.repeat(70000), message({}, {})), {code: 'SIEVE_INVALID'});
  const deep = 'if true {'.repeat(20) + 'keep;' + '}'.repeat(20);
  assert.doesNotThrow(() => evaluateSieve(deep, message({}, {})));
  // Deep nesting fits under 64 KiB and must fail as a typed error, not a stack overflow.
  assert.throws(() => evaluateSieve('if ' + 'not '.repeat(15000) + 'true {}', message({}, {})), {code: 'SIEVE_LIMIT'});
});

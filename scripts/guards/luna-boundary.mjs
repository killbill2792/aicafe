import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const roots = ['lib/luna/', 'components/luna/', 'app/api/luna/'];
const ledger = 'docs/plans/luna-rebuild.md';
const driver = 'scripts/db/luna-engine-driver.mjs';
const code = /\.[cm]?[jt]sx?$/;
const test = /(?:\.(?:test|spec)\.|(?:^|\/)(?:__tests__|__fixtures__)\/)/;
export const replacement = p => roots.some(root => p.startsWith(root)) && code.test(p) && !test.test(p);
const shared = p => /^lib\/(?:luna\/shared|auth|access|metrics|calc|connectors|data|supabase|inventory|staffCommunication|staffCoordination|purchasing|operating|pos)\//.test(p);
const protectedPath = p => [
  /^lib\/whatsapp\/supervisor\.server\./,
  /^lib\/ai\/agent\/(?:loop|jobs|persist)\.server\./,
  /^lib\/ai\/conversations\/(?:agentRunner|authorizedTurn|replyWriter|replyValidation|scenarioPresentation|nativePresentation|presentation|domainProjections|tableFormatting)\./,
  /^lib\/ai\/research\/(?:turn|backgroundContinuation|presentation|inlineStream)\./,
  /^lib\/ai\/supervisor\/(?:loop\/engine|runs\/worker|routines\/(?:dispatch|objective|investigation))\./,
  /^app\/api\/(?:ai\/threads\/\[threadId\]\/agent\/|cron\/(?:refresh-derived|supervisor-run-worker)\/)/,
  /^components\/home\/(?:ChatStart|ChatJobProgress|ChatMarkdown|SupervisorChatComposer|SupervisorRichPresentation|PresentationBoundary|chatExperience|useAgentJobWatcher|supervisorReplyPresentation)\./,
].some(pattern => pattern.test(p));
const controls = p => /^scripts\/(?:guards\/(?:luna-boundary[^/]*|run-all\.mjs)|db\/(?:luna-engine-race\.mjs|run-all\.sh)|acceptance\/owner-gate\.mjs)$/.test(p) ||
  p === '.github/workflows/ai-cafe-pr-baseline.yml';
const git = (...args) => execFileSync('git', args, {encoding:'utf8', maxBuffer:64*1024*1024});

function snapshot(ref) {
  const files = new Map();
  for (const row of git('ls-tree','-rz',ref).split('\0').filter(Boolean)) {
    const tab = row.indexOf('\t');
    const [mode,,hash] = row.slice(0,tab).split(' ');
    files.set(row.slice(tab+1), {mode, hash});
  }
  const blobs = new Map();
  const read = p => {
    const hash = files.get(p).hash;
    if (!blobs.has(hash)) blobs.set(hash,git('cat-file','blob',hash));
    return blobs.get(hash);
  };
  return { files, read };
}

function imports(file, source) {
  const out = [];
  function visit(n) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      if (n.moduleSpecifier) out.push(n.moduleSpecifier.text);
    } else if (ts.isExternalModuleReference(n)) {
      out.push(ts.isStringLiteralLike(n.expression) ? n.expression.text : null);
    } else if (ts.isCallExpression(n) && (n.expression.kind === ts.SyntaxKind.ImportKeyword ||
        n.expression.getText() === 'require' || n.expression.getText() === 'module.require')) {
      const arg = n.arguments[0];
      out.push(arg && ts.isStringLiteralLike(arg) ? arg.text : null);
    }
    ts.forEachChild(n,visit);
  }
  visit(ts.createSourceFile(file,source,ts.ScriptTarget.Latest,true));
  return out;
}

export function graphErrors(tree, seeds) {
  if (!seeds.length) return [];
  const root = '/repo';
  const host = {
    fileExists: p => tree.files.has(posix.relative(root,p)),
    readFile: p => tree.files.has(posix.relative(root,p)) ? tree.read(posix.relative(root,p)) : undefined,
  };
  const config = ts.parseConfigFileTextToJson('tsconfig.json',tree.read('tsconfig.json'));
  if (config.error) throw Error('Unreadable TypeScript configuration');
  const {options,errors} = ts.convertCompilerOptionsFromJson(config.config.compilerOptions,root);
  if (errors.length) throw Error('Invalid TypeScript compiler options');
  options.baseUrl ??= root;
  const edges = new Map(), errorsFound = new Set();
  function dependencies(file) {
    if (edges.has(file)) return edges.get(file);
    const result = [];
    for (const spec of imports(file,tree.read(file))) {
      if (spec === null) { result.push({error:'computed module loading prevents dependency verification'}); continue; }
      const found = ts.resolveModuleName(spec,root+'/'+file,options,host).resolvedModule;
      if (found) {
        const target = posix.relative(root,found.resolvedFileName);
        if (code.test(target)) result.push({target});
      } else if (/^(?:\.|@\/|\/)/.test(spec) && !/\.(?:css|svg|png|jpe?g|webp)$/.test(spec)) {
        result.push({error:'unresolved local dependency '+spec});
      }
    }
    edges.set(file,result);
    return result;
  }
  for (const seed of seeds) {
    const visited = new Set();
    function walk(file, sharedOnly) {
      const key = sharedOnly + ':' + file;
      if (visited.has(key)) return;
      visited.add(key);
      const report = message => errorsFound.add(seed+':1: '+file+' '+message);
      if (tree.files.get(file).mode === '120000') {
        report('symlink crosses an unchecked module boundary');
        return;
      }
      for (const {target,error} of dependencies(file)) {
        if (error) report(error);
        else if (protectedPath(target) || (sharedOnly && replacement(target) && !shared(target))) {
          report('forbidden dependency '+target);
        } else walk(target,sharedOnly || shared(target));
      }
    }
    walk(seed,shared(seed));
  }
  return [...errorsFound];
}

export function audit(base, head, branch = '') {
  const before = snapshot(base), after = snapshot(head);
  const changed = [...new Set([...before.files.keys(),...after.files.keys()])]
    .filter(p => before.files.get(p)?.hash !== after.files.get(p)?.hash || before.files.get(p)?.mode !== after.files.get(p)?.mode);
  const active = [...after.files.keys()].filter(replacement);
  const foundation = new Set(['AGENTS.md',ledger,'docs/plans/luna-rebuild-handoff.md',
    'scripts/db/luna-engine-race.mjs','scripts/db/run-all.sh','scripts/guards/run-all.mjs',
    'scripts/guards/luna-boundary.mjs','scripts/guards/luna-boundary.test.ts']);
  if (branch === 'luna/complete-rebuild' && changed.some(p => !foundation.has(p)))
    return [ledger+':1: PR 594 is limited to development architecture and safeguards'];
  const rebuild = branch === 'luna/operator-rebuild' || changed.some(replacement);
  const errors = graphErrors(after,active);
  // A change in an intermediate helper can break an untouched shared service.
  if (changed.some(p => (code.test(p) && !test.test(p) && /^(lib|app|components)\//.test(p)) || p === 'tsconfig.json')) {
    const services = tree => [...tree.files.keys()].filter(p => shared(p) && code.test(p) && !test.test(p));
    const previous = new Set(graphErrors(before,services(before)));
    errors.push(...graphErrors(after,services(after)).filter(e => !previous.has(e)));
  }
  if (rebuild) {
    if (changed.some(controls)) errors.push(ledger+':1: change enforcement separately from replacement development');
    const entries = after.read(ledger).split('\n').filter(l => l.startsWith('| Legacy exception |')).map(l => l.split('|').slice(2,-1).map(c => c.trim()));
    for (const p of changed.filter(protectedPath)) {
      const old = before.files.get(p)?.hash ?? 'absent', next = after.files.get(p)?.hash ?? 'absent';
      if (!entries.some(([path,from,to,reason,proof,exit]) => path===p && from===old && to===next && reason && exit && /(?:test|spec)/.test(proof) && after.files.has(proof)))
        errors.push(p+':1: missing exact-path, revision-bound legacy exception with reason, test and retirement scope');
    }
    if (active.length && !after.files.has(driver)) errors.push(driver+':1: replacement requires the migrated database two-engine race driver');
  }
  return errors;
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const head = process.env.HEAD_SHA || 'HEAD';
  const base = git('merge-base',process.env.BASE_SHA || 'origin/main',head).trim();
  const errors = audit(base,head,process.env.GITHUB_HEAD_REF || git('branch','--show-current').trim());
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}

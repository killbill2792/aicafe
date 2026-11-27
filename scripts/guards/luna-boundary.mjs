import { execFileSync } from 'node:child_process';
import { posix } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const roots = ['lib/luna/', 'components/luna/', 'app/api/luna/'];
const ledger = 'docs/plans/luna-rebuild.md';
const driver = 'scripts/db/luna-engine-driver.mjs';
const code = /\.[cm]?[jt]sx?$/;
const test = /(?:\.(?:test|spec)\.|(?:^|\/)(?:__tests__|__fixtures__)\/)/;
const lunaSource = p => roots.some(root => p.startsWith(root)) && code.test(p) && !test.test(p);
export const replacement = p => lunaSource(p) && !p.startsWith('lib/luna/shared/');
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
// Orchestration helpers in the old agent package are private by default. Its
// business tool adapters remain available subject to the same transitive walk.
const legacyDependency = p => protectedPath(p) || /^lib\/ai\/agent\/(?!tools\/)/.test(p);
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
  function directLoader(call) {
    return ts.isCallExpression(call) &&
      ['require', 'module.require', 'import'].includes(call.expression.getText());
  }
  function requiresInspection(node) {
    if (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) {
      const receiver = node.expression.getText();
      const property = ts.isPropertyAccessExpression(node) ? node.name : node.argumentExpression;
      if ((receiver === 'globalThis' || receiver === 'global') && property.text === 'require') return true;
      if (receiver === 'process' && property.text === 'getBuiltinModule') return true;
    }
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (node.text === 'module' && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === 'exports') return false;
      if (parent.parent.expression === parent && directLoader(parent.parent)) return false;
    }
    if (node.text !== 'require' && node.text !== 'module') return false;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    if (parent.name === node && !ts.isShorthandPropertyAssignment(parent)) return false;
    return parent.expression !== node || !directLoader(parent);
  }
  function visit(n) {
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const clause = n.importClause || n.exportClause;
      const members = clause?.namedBindings?.elements || clause?.elements;
      const erased = n.isTypeOnly || clause?.isTypeOnly ||
        (!clause?.name && members?.length && members.every(member=>member.isTypeOnly));
      if (n.moduleSpecifier && !erased) out.push(n.moduleSpecifier.text);
    } else if (ts.isExternalModuleReference(n) && !n.parent.isTypeOnly) {
      out.push(ts.isStringLiteralLike(n.expression) ? n.expression.text : null);
    } else if (directLoader(n)) {
      const arg = n.arguments[0];
      out.push(arg && ts.isStringLiteralLike(arg) ? arg.text : null);
    } else if (requiresInspection(n)) {
      out.push(null);
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
  const config = ts.getParsedCommandLineOfConfigFile(root+'/tsconfig.json',{},{
    ...host, useCaseSensitiveFileNames:true, getCurrentDirectory:()=>root,
    readDirectory:()=>seeds.map(path=>root+'/'+path),
    onUnRecoverableConfigFileDiagnostic:diagnostic=>{ throw Error(ts.flattenDiagnosticMessageText(diagnostic.messageText,'\n')); },
  });
  if (!config || config.errors.some(e=>e.code!==18003)) throw Error('Invalid TypeScript configuration in Git tree');
  const {options} = config;
  options.baseUrl ??= root;
  const aliases = Object.keys(options.paths ?? {});
  function localSpecifier(spec) {
    return /^(?:\.|@\/|\/|#)/.test(spec) || aliases.some(pattern => {
      const star = pattern.indexOf('*');
      return star < 0 ? pattern === spec :
        spec.startsWith(pattern.slice(0,star)) && spec.endsWith(pattern.slice(star+1));
    });
  }
  const edges = new Map(), errorsFound = new Set();
  function dependencies(file) {
    if (edges.has(file)) return edges.get(file);
    const result = [];
    for (const spec of imports(file,tree.read(file))) {
      if (spec === null) { result.push({error:'computed module loading prevents dependency verification'}); continue; }
      if (spec === 'node:module' || spec === 'module') {
        result.push({error:'Node module loader prevents dependency verification'});
        continue;
      }
      const found = ts.resolveModuleName(spec,root+'/'+file,options,host).resolvedModule;
      if (found) {
        const target = posix.relative(root,found.resolvedFileName);
        if (code.test(target)) result.push({target});
        // TypeScript can resolve a declaration in front of its runtime sibling.
        const runtime = target.replace(/\.d\.(ts|mts|cts)$/,(_,ext)=>({ts:'.js',mts:'.mjs',cts:'.cjs'})[ext]);
        if (runtime !== target && tree.files.has(runtime)) result.push({target:runtime});
      } else if (localSpecifier(spec) && !/\.(?:css|svg|png|jpe?g|webp)$/.test(spec)) {
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
        else if (legacyDependency(target) || (sharedOnly && replacement(target) && !shared(target))) {
          report('forbidden dependency '+target);
        } else walk(target,sharedOnly || shared(target));
      }
    }
    walk(seed,shared(seed));
  }
  return [...errorsFound];
}

function exceptionRows(tree, kind) {
  if (!tree.files.has(ledger)) return [];
  return tree.read(ledger).split('\n').filter(line => line.startsWith('| '+kind+' |'));
}

export function audit(base, head, branch = '', trustedBase = base, regressions = new Set()) {
  const before = snapshot(base), after = snapshot(head);
  const changed = [...new Set([...before.files.keys(),...after.files.keys()])]
    .filter(p => before.files.get(p)?.hash !== after.files.get(p)?.hash || before.files.get(p)?.mode !== after.files.get(p)?.mode);
  const active = [...after.files.keys()].filter(replacement);
  const foundation = new Set(['AGENTS.md',ledger,'docs/plans/luna-rebuild-handoff.md',
    'scripts/db/luna-engine-race.mjs','scripts/db/run-all.sh','scripts/guards/run-all.mjs',
    'scripts/guards/luna-boundary.mjs','scripts/guards/luna-boundary.test.ts',
    '.github/workflows/ai-cafe-pr-baseline.yml']);
  if (branch === 'luna/complete-rebuild' && changed.some(p => !foundation.has(p)))
    return [ledger+':1: PR 594 is limited to development architecture and safeguards'];
  const legacyEdits = changed.filter(p => legacyDependency(p) && !test.test(p));
  const rebuild = branch === 'luna/operator-rebuild' || changed.some(replacement);
  const policy = 'scripts/guards/luna-boundary.mjs';
  const errors = graphErrors(after,[...after.files.keys()].filter(lunaSource));
  // A change in an intermediate helper can break an untouched shared service.
  if (changed.some(p => code.test(p) || p === 'tsconfig.json')) {
    const services = tree => [...tree.files.keys()].filter(p => shared(p) && code.test(p) && !test.test(p));
    const previous = new Set(graphErrors(before,services(before)));
    errors.push(...graphErrors(after,services(after)).filter(e => !previous.has(e)));
  }
  const trusted = trustedBase === base ? before : snapshot(trustedBase);
  // The shared DB runner regularly gains independent tests. Preserve its Luna
  // registration; the baseline DB job also runs the oracle directly.
  const dbRunner = 'scripts/db/run-all.sh';
  const policyEdits = changed.filter(p => controls(p) && p !== dbRunner);
  if (trusted.files.has(policy) && changed.includes(dbRunner) &&
      (!after.files.has(dbRunner) || !after.read(dbRunner).includes('node scripts/db/luna-engine-race.mjs')))
    errors.push(dbRunner+':1: retain the registered Luna database oracle');
  if ((rebuild || legacyEdits.length) && policyEdits.length)
    errors.push(ledger+':1: change enforcement separately from replacement or protected legacy code');
  if (before.files.has(policy) && !after.files.has(policy))
    errors.push(policy+':1: approved boundary guard was removed');

  // A row in the candidate cannot authorize itself. The independently reviewed
  // policy baseline pins both the proposed change and the regression to run.
  for (const [kind, paths] of [['Legacy exception',legacyEdits], ['Safeguard change',trusted.files.has(policy) ? policyEdits : []]]) {
    if (!paths.length) continue;
    const approved = new Set(exceptionRows(trusted,kind));
    const rows = exceptionRows(after,kind).filter(row => approved.has(row));
    for (const path of paths) {
      const from = before.files.get(path)?.hash ?? 'absent';
      const to = after.files.get(path)?.hash ?? 'absent';
      const valid = rows.some(row => {
        const [file, old, next, reason, proof, proofBlob, exit] = row.split('|').slice(2,-1).map(c => c.trim());
        const regression = after.files.get(proof);
        if (file !== path || old !== from || next !== to || !reason || !exit ||
            !/\.test\.tsx?$/.test(proof) || regression?.mode !== '100644' || regression.hash !== proofBlob) return false;
        regressions.add(proof);
        return true;
      });
      if (!valid) errors.push(path+':1: missing independently reviewed, revision-bound '+kind.toLowerCase()+' and pinned regression');
    }
  }
  if (active.length && !after.files.has(driver)) errors.push(driver+':1: replacement requires the migrated database two-engine race driver');
  return errors;
}

if (process.argv[1] === '-' || (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)) {
  const head = process.env.HEAD_SHA || 'HEAD';
  const base = git('merge-base',process.env.BASE_SHA || 'origin/main',head).trim();
  const trustedBase = process.env.LUNA_POLICY_BASE || base;
  const regressions = new Set();
  const errors = audit(base,head,process.env.GITHUB_HEAD_REF || git('branch','--show-current').trim(),trustedBase,regressions);
  if (!errors.length && process.argv.includes('--list-regressions'))
    for (const file of regressions) process.stdout.write(file+'\0');
  for (const error of errors) console.error(error);
  if (errors.length) process.exitCode = 1;
}

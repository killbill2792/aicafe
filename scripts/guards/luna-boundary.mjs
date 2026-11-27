import { execFileSync } from 'node:child_process';
import { isBuiltin } from 'node:module';
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
const shared = p => /^lib\/(?:luna\/shared|ai\/agent\/tools|auth|access|metrics|calc|connectors|data|supabase|inventory|staffCommunication|staffCoordination|purchasing|operating|pos)\//.test(p);
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
const controls = p => p === 'AGENTS.md' ||
  /^scripts\/(?:guards\/(?:luna-boundary[^/]*|lib\/luna-boundary-proof\.mjs|run-all\.mjs)|db\/(?:luna-engine-race\.mjs|run-all\.sh)|acceptance\/owner-gate\.mjs|e2e\/targeted\.mjs)$/.test(p) ||
  /^(?:next\.config\.[^/]+|vitest\.config\.[^/]+|\.github\/workflows\/ai-cafe-pr-baseline\.yml)$/.test(p);
// Package modules can supply dependencies through the lockfile. For Node's
// built-in modules, admit data and I/O APIs the application can inspect.
const nodeDataModules = new Set([
  'assert', 'assert/strict', 'async_hooks', 'buffer', 'crypto', 'events',
  'fs', 'fs/promises', 'http', 'https', 'os', 'path', 'path/posix', 'path/win32',
  'perf_hooks', 'querystring', 'stream', 'stream/consumers', 'stream/promises',
  'stream/web', 'string_decoder', 'timers', 'timers/promises', 'url', 'util',
  'util/types', 'zlib',
]);
const processMembers = new Set(['arch', 'cwd', 'env', 'hrtime', 'platform', 'uptime', 'version', 'versions']);
const globalMembers = new Set([
  'AbortController', 'AbortSignal', 'Buffer', 'Headers', 'Request', 'Response',
  'TextDecoder', 'TextEncoder', 'URL', 'URLSearchParams', 'WebSocket', 'atob',
  'btoa', 'clearInterval', 'clearTimeout', 'console', 'crypto', 'document',
  'fetch', 'location', 'navigator', 'performance', 'process', 'queueMicrotask',
  'setInterval', 'setTimeout', 'structuredClone', 'window',
]);
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

function imports(file, source, compilerOptions) {
  const out = [];
  let hasJsx = false;
  const filename = '/repo/' + file;
  const parsed = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true);
  // Bind local names without executing or resolving anything. Type-only
  // references and ordinary local variables can share names with host globals.
  let checker;
  const opaqueGlobals = new Set(['require', 'eval', 'Function']);
  function hostIdentifier(node, name) {
    if (!ts.isIdentifier(node) || node.text !== name) return false;
    if (!checker) {
      const options = {noLib:true, noResolve:true, noEmit:true, types:[]};
      const host = ts.createCompilerHost(options);
      host.getSourceFile = path => path === filename ? parsed : undefined;
      checker = ts.createProgram([filename], options, host).getTypeChecker();
    }
    return !(ts.isShorthandPropertyAssignment(node.parent)
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node))?.declarations?.length;
  }
  function directLoader(call) {
    if (!ts.isCallExpression(call)) return false;
    const fn = call.expression;
    return fn.kind === ts.SyntaxKind.ImportKeyword || hostIdentifier(fn, 'require') ||
      (ts.isPropertyAccessExpression(fn) && fn.name.text === 'require' && hostIdentifier(fn.expression, 'module'));
  }
  const isMemberAccess = node => ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node);
  const isGlobalObject = node => hostIdentifier(node, 'globalThis') || hostIdentifier(node, 'global');
  function memberName(node) {
    if (ts.isPropertyAccessExpression(node)) return node.name.text;
    if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression))
      return node.argumentExpression.text;
    return null;
  }
  function isIdentifierReference(node) {
    if (!ts.isIdentifier(node)) return false;
    const parent = node.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
    return parent.name !== node || ts.isShorthandPropertyAssignment(parent);
  }
  function opaqueRuntimeObjectAccess(object, permitted) {
    const access = object.parent;
    // A reference to the whole object can be rebound or destructured. A named
    // member access can be checked here without rejecting unrelated names.
    if (ts.isTypeOfExpression(access)) return false;
    if (!isMemberAccess(access) || access.expression !== object) return true;
    const name = memberName(access);
    return !permitted.has(name);
  }
  function requiresInspection(node) {
    if (isMemberAccess(node) && isGlobalObject(node.expression) && memberName(node) === 'process')
      return opaqueRuntimeObjectAccess(node, processMembers);
    if (!isIdentifierReference(node)) return false;
    const parent = node.parent;
    if (isGlobalObject(node)) return opaqueRuntimeObjectAccess(node, globalMembers);
    if (hostIdentifier(node, 'process')) return opaqueRuntimeObjectAccess(node, processMembers);
    if (hostIdentifier(node, 'module') && ts.isPropertyAccessExpression(parent) && parent.expression === node) {
      if (parent.name.text === 'exports') return false;
      if (parent.parent.expression === parent && directLoader(parent.parent)) return false;
    }
    if (!(node.text === 'module' || opaqueGlobals.has(node.text)) || !hostIdentifier(node, node.text)) return false;
    return parent.expression !== node || !directLoader(parent);
  }
  function visit(n) {
    if (ts.isTypeReferenceNode(n) || ts.isTypeQueryNode(n)) return;
    if (ts.isJsxElement(n) || ts.isJsxSelfClosingElement(n) || ts.isJsxFragment(n)) hasJsx = true;
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n)) {
      const clause = n.importClause || n.exportClause;
      const members = clause?.namedBindings?.elements || clause?.elements;
      const erased = n.isTypeOnly || clause?.isTypeOnly ||
        (!clause?.name && members?.length && members.every(member=>member.isTypeOnly));
      if (erased) return;
      if (n.moduleSpecifier) out.push({spec:n.moduleSpecifier.text, mode:ts.ModuleKind.ESNext});
    } else if (ts.isExternalModuleReference(n) && !n.parent.isTypeOnly) {
      out.push(ts.isStringLiteralLike(n.expression) ? {spec:n.expression.text, mode:ts.ModuleKind.CommonJS} : null);
    } else if (directLoader(n)) {
      const arg = n.arguments[0];
      const mode = n.expression.kind === ts.SyntaxKind.ImportKeyword ? ts.ModuleKind.ESNext : ts.ModuleKind.CommonJS;
      out.push(arg && ts.isStringLiteralLike(arg) ? {spec:arg.text, mode} : null);
    } else if (requiresInspection(n)) {
      out.push(null);
    }
    if ((ts.isImportSpecifier(n) || ts.isExportSpecifier(n)) && n.isTypeOnly) return;
    ts.forEachChild(n,visit);
  }
  visit(parsed);
  if (hasJsx) {
    const base = ts.getJSXImplicitImportBase(compilerOptions, parsed);
    const spec = ts.getJSXRuntimeImport(base, compilerOptions);
    if (spec) out.push({spec, mode:ts.ModuleKind.ESNext});
  }
  return out;
}

const packageMetadata = (tree, path = 'package.json') => tree.files.has(path) ? JSON.parse(tree.read(path)) : {};

// Every reachable conditional target has a path of enabled conditions in the
// package manifest. Probe those paths with the same TypeScript resolver used
// for the ordinary import instead of maintaining a list of build targets.
function packageEntry(mapping, key) {
  if (!mapping || typeof mapping !== 'object') return undefined;
  if (Object.hasOwn(mapping, key)) return { value:mapping[key], wildcard:'' };
  const patterns = Object.keys(mapping).filter(pattern => {
    const [prefix,suffix,extra] = pattern.split('*');
    return extra === undefined && suffix !== undefined &&
      key.startsWith(prefix) && key.endsWith(suffix) && key.length >= pattern.length;
  }).sort((left,right) => right.indexOf('*')-left.indexOf('*') || right.length-left.length);
  if (!patterns.length) return undefined;
  const pattern = patterns[0];
  const star = pattern.indexOf('*');
  return {value:mapping[pattern],wildcard:key.slice(star,key.length-(pattern.length-star-1))};
}

function conditionalTargets(entry, mode) {
  const paths = new Map();
  const external = new Set();
  const standard = new Set(['default', 'types', 'import', 'require']);
  function visit(value, conditions) {
    if (typeof value === 'string') {
      paths.set(JSON.stringify(conditions), conditions);
      if (!value.startsWith('./')) external.add(value.replaceAll('*',entry.wildcard));
    } else if (Array.isArray(value)) {
      for (const branch of value) visit(branch, conditions);
    } else if (value && typeof value === 'object') {
      for (const [key, branch] of Object.entries(value)) {
        if (key === 'types' || (key === 'import' && mode === ts.ModuleKind.CommonJS) ||
            (key === 'require' && mode !== ts.ModuleKind.CommonJS)) continue;
        visit(branch, standard.has(key) ? conditions : [...conditions,key]);
      }
    }
  }
  if (entry) visit(entry.value, []);
  return { paths:[...paths.values()], external };
}

function declaredPackages(tree) {
  const manifest = packageMetadata(tree);
  const lock = packageMetadata(tree, 'package-lock.json').packages ?? {};
  const deps = {...manifest.dependencies, ...manifest.optionalDependencies, ...manifest.devDependencies};
  return new Set(Object.keys(deps).filter(name => {
    const item = lock['node_modules/' + name];
    return typeof item?.version === 'string' && !item.link && /^https:\/\//.test(item.resolved ?? '') &&
      typeof item.integrity === 'string';
  }));
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
  const packages = declaredPackages(tree);
  const dataAsset = /\.(?:json|css|svg|png|jpe?g|webp)$/;
  const cache = ts.createModuleResolutionCache(root, p => p, options);
  const runtimeHost = {
    ...host,
    fileExists: p => !/\.d\.[cm]?ts$/.test(p) && host.fileExists(p),
  };
  const scopes = new Map();
  function packageScope(directory) {
    if (scopes.has(directory)) return scopes.get(directory);
    const manifest = posix.join(directory, 'package.json');
    if (tree.files.has(manifest)) {
      const scope = packageMetadata(tree, manifest);
      scopes.set(directory, scope);
      return scope;
    }
    const scope = directory === '.' ? {} : packageScope(posix.dirname(directory));
    scopes.set(directory, scope);
    return scope;
  }
  const edges = new Map(), errorsFound = new Set();
  function externalError(spec) {
    if (spec.startsWith('node:') || isBuiltin(spec))
      return nodeDataModules.has(spec.replace(/^node:/, '')) ? null : 'unapproved Node builtin '+spec;
    const name = spec.match(/^((?:@[\w.-]+\/)?[a-zA-Z0-9_][\w.-]*)(?:\/[\w.-]+)*$/)?.[1];
    if (name && packages.has(name) && !spec.split('/').some(part => part === '.' || part === '..')) return null;
    return 'unresolved local dependency or undeclared package '+spec;
  }
  function dependencies(file) {
    if (edges.has(file)) return edges.get(file);
    const result = [];
    function addRuntimeTarget(target) {
      if (tree.files.get(target)?.mode === '120000' || code.test(target)) result.push({target});
      else if (!dataAsset.test(target)) result.push({error:'unverified runtime file '+target});
    }
    for (const edge of imports(file,tree.read(file),options)) {
      if (edge === null) { result.push({error:'computed module loading prevents dependency verification'}); continue; }
      const {spec,mode} = edge;
      const found = ts.resolveModuleName(spec,root+'/'+file,options,host,cache,undefined,mode).resolvedModule;
      if (found) {
        const target = posix.relative(root,found.resolvedFileName);
        if (/\.d\.[cm]?ts$/.test(target)) {
          // Run the same resolver with declarations hidden to follow runtime
          // siblings and package conditions instead of guessing by extension.
          const runtime = ts.resolveModuleName(spec,root+'/'+file,options,runtimeHost,undefined,undefined,mode).resolvedModule;
          if (runtime) addRuntimeTarget(posix.relative(root,runtime.resolvedFileName));
          else result.push({error:'no runtime source for '+spec});
        } else addRuntimeTarget(target);
      }
      const scope = packageScope(posix.dirname(file));
      let entry;
      if (spec.startsWith('#')) entry = packageEntry(scope.imports, spec);
      else if (scope.name && (spec === scope.name || spec.startsWith(scope.name + '/'))) {
        const key = '.' + spec.slice(scope.name.length);
        const subpaths = scope.exports && typeof scope.exports === 'object' &&
          Object.keys(scope.exports).some(path => path.startsWith('.'));
        entry = subpaths ? packageEntry(scope.exports,key) : key === '.' ? {value:scope.exports,wildcard:''} : undefined;
      }
      const conditions = conditionalTargets(entry, mode);
      let hasConditionalTarget = false;
      for (const path of conditions.paths) {
        const runtimeOptions = {...options,customConditions:path};
        const runtime = ts.resolveModuleName(spec,root+'/'+file,runtimeOptions,runtimeHost,undefined,undefined,mode).resolvedModule;
        if (runtime) {
          hasConditionalTarget = true;
          addRuntimeTarget(posix.relative(root,runtime.resolvedFileName));
        }
      }
      for (const target of conditions.external) {
        const error = externalError(target);
        if (error) result.push({error});
      }
      if (found || hasConditionalTarget || conditions.external.size) {
        continue;
      }
      const asset = spec.startsWith('.') && posix.join(posix.dirname(file),spec);
      if (asset && dataAsset.test(asset) && tree.files.has(asset)) {
        if (tree.files.get(asset).mode === '120000') result.push({target:asset});
        continue;
      }
      const error = externalError(spec);
      if (error) result.push({error});
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
      const entry = tree.files.get(file);
      if (!entry || entry.mode === '120000') {
        report('symlink crosses an unchecked module boundary');
        return;
      }
      for (const {target,error} of dependencies(file)) {
        if (error) report(error);
        else if (test.test(target) || legacyDependency(target) || (sharedOnly && replacement(target) && !shared(target))) {
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

function changedPaths(before, after) {
  return [...new Set([...before.files.keys(), ...after.files.keys()])]
    .filter(p => before.files.get(p)?.hash !== after.files.get(p)?.hash ||
      before.files.get(p)?.mode !== after.files.get(p)?.mode);
}

export function audit(base, head, branch = '', trustedBase = base, regressions = new Set()) {
  const before = snapshot(base), after = snapshot(head);
  const changed = changedPaths(before, after);
  const trusted = trustedBase === base ? before : snapshot(trustedBase);
  const trustedChanges = trusted === before ? changed : changedPaths(trusted, after);
  const active = [...after.files.keys()].filter(replacement);
  const foundation = new Set(['AGENTS.md',ledger,'docs/plans/luna-rebuild-handoff.md',
    'scripts/db/luna-engine-race.mjs','scripts/db/run-all.sh','scripts/guards/run-all.mjs',
    'scripts/guards/luna-boundary.mjs','scripts/guards/luna-boundary.test.ts','scripts/guards/lib/luna-boundary-proof.mjs',
    '.github/workflows/ai-cafe-pr-baseline.yml']);
  if (branch === 'luna/complete-rebuild' && changed.some(p => !foundation.has(p)))
    return [ledger+':1: PR 594 is limited to development architecture and safeguards'];
  const rebuild = branch === 'luna/operator-rebuild' || trustedChanges.some(replacement);
  const policy = 'scripts/guards/luna-boundary.mjs';
  const errors = graphErrors(after,[...after.files.keys()].filter(lunaSource));
  // Resolve both trees for every change. Imports can be redirected without
  // touching a source file or the top-level TypeScript configuration.
  if (trustedChanges.length) {
    const services = tree => [...tree.files.keys()].filter(p => shared(p) && code.test(p) && !test.test(p));
    const previous = new Set(graphErrors(trusted,services(trusted)));
    errors.push(...graphErrors(after,services(after)).filter(e => !previous.has(e)));
  }
  const legacyEdits = trustedChanges.filter(p => legacyDependency(p) && !test.test(p));
  // The shared DB runner regularly gains independent tests. Preserve its Luna
  // registration; the baseline DB job also runs the oracle directly.
  const dbRunner = 'scripts/db/run-all.sh';
  const browserMappingChanged = JSON.stringify(packageMetadata(trusted).browser) !== JSON.stringify(packageMetadata(after).browser);
  const controlChanges = trustedChanges.filter(p => controls(p) || (p === 'package.json' && browserMappingChanged));
  const policyEdits = controlChanges.filter(p => p !== dbRunner);
  const oracleRegistration = /^\s*(?:SUPERVISOR_RUN_DB_URL=\S+\s+)?node scripts\/db\/luna-engine-race\.mjs\s*$/m;
  if (trusted.files.has(policy) && controlChanges.includes(dbRunner) &&
      (!after.files.has(dbRunner) || !oracleRegistration.test(after.read(dbRunner))))
    errors.push(dbRunner+':1: retain the registered Luna database oracle');
  if ((rebuild || legacyEdits.length) && policyEdits.length)
    errors.push(ledger+':1: change enforcement separately from replacement or protected legacy code');
  if (trusted.files.has(policy) && !after.files.has(policy))
    errors.push(policy+':1: approved boundary guard was removed');

  // A row in the candidate cannot authorize itself. The independently reviewed
  // policy baseline pins both the proposed change and the regression to run.
  for (const [kind, paths] of [
    ['Legacy exception', legacyEdits],
    ['Safeguard change', trusted.files.has(policy) ? policyEdits : []],
  ]) {
    if (!paths.length) continue;
    const approved = new Set(exceptionRows(trusted,kind));
    const rows = exceptionRows(after,kind).filter(row => approved.has(row));
    for (const path of paths) {
      const from = trusted.files.get(path)?.hash ?? 'absent';
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

import {settings} from './settings.mjs';
import {githubFailure,githubNetworkFailure} from './github.mjs';
// Durable dispatcher ledger in a SEPARATE PRIVATE GitHub repository.
// GitHub Contents API gives compare-and-swap writes via blob SHA.
const PATH = settings.ledger.path;
const empty = () => ({ version: 1, updated_at: null, tasks: {}, actions: {} });
export function assertLedgerShape(value) {
  if (!value || value.version !== 1 || !value.tasks || typeof value.tasks !== "object" ||
    Array.isArray(value.tasks) || !value.actions || typeof value.actions !== "object" || Array.isArray(value.actions)) throw new Error("Invalid dispatcher ledger");
  return value;
}
export function sanitizeLedger(value) {
  // Verified deliveries no longer need prompt text, only the signed hash and
  // audit receipt. Keep text for undelivered/planned actions and preserve the
  // receipt wire format unchanged.
  for (const action of Object.values(value?.actions || {})) {
    if ((action.status === 'submitted' || action.superseded_receipt) &&
        action.delivery && Object.hasOwn(action.delivery,'prompt'))
      delete action.delivery.prompt;
  }
  // Private ledger still never stores auth material or model response contents.
  const serialized = JSON.stringify(value);
  if (/("(?:cookie|password|access_token|refresh_token|session_state|model_response|assistant_reply)"\s*:)/i.test(serialized)) throw new Error("Forbidden secret/content field in dispatcher ledger");
  return assertLedgerShape(value);
}
export class GitHubLedger {
  constructor({ repo, token, path=PATH, fetchFn = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token) throw new Error("Private ledger repo/token required");
    this.repo = repo;
    this.path = path;
    this.token = token;
    this.fetchFn = fetchFn;
    this.privateVerified = false;
  }
  async request(path, options = {}) {
    // Bounded retries for transient GitHub/API infrastructure failures only.
    // Never retry CAS collisions or validation/auth failures as blind writes.
    let response;
    for (let attempt = 0; attempt < 3; attempt++) {
      response = await this.fetchFn(`https://api.github.com/repos/${this.repo}${path}`, {
        ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
          "X-GitHub-Api-Version": "2022-11-28", ...options.headers },
      }).catch(()=>{throw githubNetworkFailure('Ledger');});
      if (response.ok || !Number.isInteger(response.status) ||
          response.status < 500 || response.status > 599 || attempt === 2) break;
      await new Promise(resolve => setTimeout(resolve, 250 * (2 ** attempt)));
    }
    if (!response.ok) {
      const error=await githubFailure(response,'Ledger',this.token);
      error.message='Ledger HTTP '+response.status+'; '+error.message;
      if (response.status === 404 && (!options.method || options.method === "GET")) return { absent: true };
      if ([409, 412, 422].includes(response.status)) throw Object.assign(error, { code: "CONFLICT" });
      throw error;
    }
    return response.json();
  }
  async verifyPrivate() {
    if(this.privateVerified)return;
    const data = await this.request("");
    if (data.absent || data.private !== true) throw new Error("Ledger must be a private repository");
    this.privateVerified = true;
  }
  async load() {
    // The trusted persistent runner already uses Git-CAS for writes. Read the
    // same private state via Git so large ledgers and REST quota pressure do
    // not make every observation depend on Git Trees/Blobs requests.
    if(process.env.DISPATCH_LEDGER_GIT_WRITES==='true'&&
       this.repo===settings.ledger.repo){
      const {readLedgerViaGit}=await import('./git-operations.mjs');
      return {sha:null,state:readLedgerViaGit({repo:this.repo,token:this.token})};
    }
    // Contents API intentionally returns empty content for files larger than
    // 1 MiB. Read by immutable Git blob SHA so an oversized private ledger can
    // never make the trusted dispatcher unable to reconcile.
    const tree = await this.request('/git/trees/main?recursive=1');
    if (tree.absent || !Array.isArray(tree.tree) || tree.truncated === true)
      throw new Error('Ledger Git tree invalid (keys: ' +
        Object.keys(tree || {}).join(',').slice(0,120) + ')');
    const entry = tree.tree.find(x => x.path === this.path);
    if (!entry) return { sha: null, state: empty() };
    if (entry.type !== 'blob' || !/^[a-f0-9]{40}$/.test(entry.sha || ''))
      throw new Error('Ledger Git tree entry invalid (type: ' +
        String(entry.type).slice(0,24) + ')');
    const blob = await this.request('/git/blobs/' + entry.sha);
    if (blob.absent || blob.encoding !== 'base64' ||
        typeof blob.content !== 'string' || !blob.content.trim())
      throw new Error('Ledger Git blob invalid (sha: ' + entry.sha +
        '; keys: ' + Object.keys(blob || {}).join(',').slice(0,120) +
        '; encoding: ' + String(blob?.encoding).slice(0,30) + ')');
    let parsed;
    try {
      parsed = JSON.parse(Buffer.from(blob.content.replace(/\s/g, ''), 'base64').toString('utf8'));
    } catch {
      throw new Error('Ledger Git blob has invalid JSON (sha: ' + entry.sha + ')');
    }
    return { sha: entry.sha, state: assertLedgerShape(parsed) };
  }
  async save(state, sha, message = "chore(dispatcher): reconcile task ledger") {
    sanitizeLedger(state);
    const body = { message, content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString("base64"), branch: "main" };
    if (sha) body.sha = sha;
    return this.request(`/contents/${this.path}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  // GitHub Actions' concurrency group serializes normal execution; SHA is a second safety check.
  async transaction(transform, maxRetries = 3) {
    await this.verifyPrivate();
    if(process.env.DISPATCH_LEDGER_GIT_WRITES==='true'){
      const {transactLedgerViaGit}=await import('./git-operations.mjs');
      return transactLedgerViaGit({repo:this.repo,token:this.token,transform,maxRetries});
    }
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      const { sha, state } = await this.load();
      const updated = await transform(structuredClone(state));
      if (updated === null) return { committed: false, state };
      updated.updated_at = new Date().toISOString();
      try {
        await this.save(updated, sha);
        return { committed: true, state: updated };
      } catch (error) {
        if (error.code !== "CONFLICT" || attempt === maxRetries - 1) throw error;
      }
    }
    throw new Error("Ledger transaction retry limit reached");
  }
}
export { empty as emptyLedger };

// Durable dispatcher ledger in a SEPARATE PRIVATE GitHub repository.
// GitHub Contents API gives compare-and-swap writes via blob SHA.
const PATH = "dispatcher/state.json";
const empty = () => ({ version: 1, updated_at: null, tasks: {}, actions: {} });
export function assertLedgerShape(value) {
  if (!value || value.version !== 1 || !value.tasks || typeof value.tasks !== "object" ||
    Array.isArray(value.tasks) || !value.actions || typeof value.actions !== "object" || Array.isArray(value.actions)) throw new Error("Invalid dispatcher ledger");
  return value;
}
export function sanitizeLedger(value) {
  // Private ledger still never stores auth material or model response contents.
  const serialized = JSON.stringify(value);
  if (/("(?:cookie|password|access_token|refresh_token|session_state|model_response|assistant_reply)"\s*:)/i.test(serialized)) throw new Error("Forbidden secret/content field in dispatcher ledger");
  return assertLedgerShape(value);
}
export class GitHubLedger {
  constructor({ repo, token, fetchFn = fetch }) {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo || "") || !token) throw new Error("Private ledger repo/token required");
    this.repo = repo;
    this.token = token;
    this.fetchFn = fetchFn;
  }
  async request(path, options = {}) {
    const response = await this.fetchFn(`https://api.github.com/repos/${this.repo}${path}`, {
      ...options, headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${this.token}`,
        "X-GitHub-Api-Version": "2022-11-28", ...options.headers },
    });
    if (!response.ok) {
      if (response.status === 404) return { absent: true };
      if ([409, 412, 422].includes(response.status)) throw Object.assign(new Error("Ledger write collision"), { code: "CONFLICT" });
      throw new Error(`Ledger HTTP ${response.status}`);
    }
    return response.json();
  }
  async verifyPrivate() {
    const data = await this.request("");
    if (data.absent || data.private !== true) throw new Error("Ledger must be a private repository");
  }
  async load() {
    const data = await this.request(`/contents/${PATH}?ref=main`);
    if (data.absent) return { sha: null, state: empty() };
    if (!data.content || !data.sha) throw new Error("Unexpected GitHub ledger response");
    const decoded = Buffer.from(data.content.replace(/\s/g, ""), "base64").toString("utf8");
    return { sha: data.sha, state: assertLedgerShape(JSON.parse(decoded)) };
  }
  async save(state, sha, message = "chore(dispatcher): reconcile task ledger") {
    sanitizeLedger(state);
    const body = { message, content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString("base64"), branch: "main" };
    if (sha) body.sha = sha;
    return this.request(`/contents/${PATH}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  }
  // GitHub Actions' concurrency group serializes normal execution; SHA is a second safety check.
  async transaction(transform, maxRetries = 3) {
    await this.verifyPrivate();
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

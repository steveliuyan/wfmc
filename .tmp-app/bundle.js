"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// .tmp-app/entry.ts
var entry_exports = {};
__export(entry_exports, {
  inspectLangPack: () => inspectLangPack,
  installLangPacks: () => installLangPacks,
  store: () => store
});
module.exports = __toCommonJS(entry_exports);

// src/main/store.ts
var import_electron = require("electron");
var import_node_fs = __toESM(require("node:fs"));
var import_node_path = __toESM(require("node:path"));
var ENC_PREFIX = "enc:";
function encryptToken(value) {
  if (!value) return value;
  try {
    if (import_electron.safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + import_electron.safeStorage.encryptString(value).toString("base64");
    }
  } catch {
  }
  return value;
}
function decryptToken(value) {
  if (!value || !value.startsWith(ENC_PREFIX)) return value;
  try {
    return import_electron.safeStorage.decryptString(Buffer.from(value.slice(ENC_PREFIX.length), "base64"));
  } catch {
    return value;
  }
}
var LEGACY_DIR_NAMES = ["zhudong-mc-launcher"];
function defaultDataDir() {
  const portable = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portable) return import_node_path.default.join(portable, "WFMC-Data");
  return import_node_path.default.join(import_electron.app.getPath("userData"), "data");
}
function defaultSettings() {
  return {
    dataDir: defaultDataDir(),
    theme: "light",
    downloadSource: "mirror",
    downloadThreads: 48,
    downloadLimitKbps: 0,
    downloadDir: "",
    maxConcurrentDownloads: 8,
    maxMemory: 4096,
    minMemory: 1024,
    javaPath: "",
    extraJvmArgs: [],
    microsoftClientId: "",
    curseforgeApiKey: "",
    showLog: true,
    proxy: "",
    onboarded: false,
    updateUrl: "steveliuyan/wfmc",
    closeToTray: true,
    autoCheckUpdate: true,
    favResources: [],
    activeAccountId: void 0
  };
}
function readJson(file, fallback) {
  try {
    if (!import_node_fs.default.existsSync(file)) return fallback;
    return { ...fallback, ...JSON.parse(import_node_fs.default.readFileSync(file, "utf-8")) };
  } catch {
    return fallback;
  }
}
function writeJson(file, data) {
  import_node_fs.default.mkdirSync(import_node_path.default.dirname(file), { recursive: true });
  import_node_fs.default.writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}
function migrateLegacyDataDir() {
  if (process.env.PORTABLE_EXECUTABLE_DIR) return;
  const target = defaultDataDir();
  if (import_node_fs.default.existsSync(import_node_path.default.join(target, "instances"))) return;
  for (const legacy of LEGACY_DIR_NAMES) {
    const old = import_node_path.default.join(import_electron.app.getPath("appData"), legacy);
    if (!import_node_fs.default.existsSync(old)) continue;
    try {
      import_node_fs.default.mkdirSync(target, { recursive: true });
      for (const name of ["instances", "java", "exports", "backups", "servers.json", "accounts.json"]) {
        const from = import_node_path.default.join(old, name);
        if (!import_node_fs.default.existsSync(from)) continue;
        import_node_fs.default.cpSync(from, import_node_path.default.join(target, name), { recursive: true, force: true });
      }
    } catch {
    }
    return;
  }
}
var Store = class {
  _settings = defaultSettings();
  _accounts = [];
  /** 设置本身放在启动器根目录（换数据目录时不会丢），账号跟着数据目录走 */
  get settingsFile() {
    const portable = process.env.PORTABLE_EXECUTABLE_DIR;
    const root = portable ? import_node_path.default.join(portable, "WFMC-Data") : import_electron.app.getPath("userData");
    return import_node_path.default.join(root, "settings.json");
  }
  get accountsFile() {
    return import_node_path.default.join(this.dataDir, "accounts.json");
  }
  load() {
    migrateLegacyDataDir();
    this._settings = readJson(this.settingsFile, defaultSettings());
    let corrected = false;
    if (process.env.PORTABLE_EXECUTABLE_DIR && this._settings.dataDir !== defaultDataDir()) {
      this._settings.dataDir = defaultDataDir();
      corrected = true;
    }
    if (!this._settings.dataDir || this._settings.dataDir.includes("zhudong-mc-launcher")) {
      this._settings.dataDir = defaultDataDir();
      corrected = true;
    }
    if (!this._settings.mirrorMigrated) {
      if (this._settings.downloadSource === "auto") this._settings.downloadSource = "mirror";
      this._settings.mirrorMigrated = true;
      corrected = true;
    }
    writeJson(this.settingsFile, this._settings);
    const raw = readJson(this.accountsFile, { accounts: [] });
    this._accounts = (Array.isArray(raw.accounts) ? raw.accounts : []).map((a) => ({
      ...a,
      accessToken: decryptToken(a.accessToken) ?? "",
      refreshToken: decryptToken(a.refreshToken)
    }));
    import_node_fs.default.mkdirSync(this.dataDir, { recursive: true });
    import_node_fs.default.mkdirSync(this.instancesDir, { recursive: true });
  }
  get settings() {
    return this._settings;
  }
  setSettings(patch) {
    this._settings = { ...this._settings, ...patch };
    writeJson(this.settingsFile, this._settings);
    import_node_fs.default.mkdirSync(this.dataDir, { recursive: true });
    import_node_fs.default.mkdirSync(this.instancesDir, { recursive: true });
    return this._settings;
  }
  get accounts() {
    return this._accounts;
  }
  setAccounts(accounts) {
    this._accounts = accounts;
    const onDisk = accounts.map((a) => ({
      ...a,
      accessToken: encryptToken(a.accessToken) ?? "",
      refreshToken: encryptToken(a.refreshToken)
    }));
    writeJson(this.accountsFile, { accounts: onDisk });
  }
  /** 当前选中的账号（多账号切换用） */
  get activeAccount() {
    const id = this._settings.activeAccountId;
    return this._accounts.find((a) => a.id === id) ?? this._accounts[0];
  }
  get dataDir() {
    return this._settings.dataDir || defaultDataDir();
  }
  get instancesDir() {
    return import_node_path.default.join(this.dataDir, "instances");
  }
  get javaDir() {
    return import_node_path.default.join(this.dataDir, "java");
  }
  get exportsDir() {
    return import_node_path.default.join(this.dataDir, "exports");
  }
  get backupsDir() {
    return import_node_path.default.join(this.dataDir, "backups");
  }
  instanceDir(id) {
    return import_node_path.default.join(this.instancesDir, id);
  }
  /** 每个实例独立的 .minecraft 目录 */
  instanceGameDir(id) {
    return import_node_path.default.join(this.instanceDir(id), "minecraft");
  }
  instanceFile(id) {
    return import_node_path.default.join(this.instanceDir(id), "instance.json");
  }
  listInstances() {
    const dir = this.instancesDir;
    if (!import_node_fs.default.existsSync(dir)) return [];
    const out = [];
    for (const name of import_node_fs.default.readdirSync(dir)) {
      const file = import_node_path.default.join(dir, name, "instance.json");
      if (!import_node_fs.default.existsSync(file)) continue;
      try {
        out.push(JSON.parse(import_node_fs.default.readFileSync(file, "utf-8")));
      } catch {
      }
    }
    for (const it of out) {
      const vId = it.versionId || it.mcVersion;
      const gameDir = this.instanceGameDir(it.id);
      const verDir = import_node_path.default.join(gameDir, "versions", vId);
      const jar = import_node_path.default.join(verDir, vId + ".jar");
      const jsonPath = import_node_path.default.join(verDir, vId + ".json");
      let ok = import_node_fs.default.existsSync(jsonPath);
      if (ok && !import_node_fs.default.existsSync(jar)) {
        try {
          const vj = JSON.parse(import_node_fs.default.readFileSync(jsonPath, "utf-8"));
          const base = vj.inheritsFrom;
          ok = !!base && import_node_fs.default.existsSync(import_node_path.default.join(gameDir, "versions", base, base + ".jar"));
        } catch {
          ok = false;
        }
      }
      it.installed = ok;
    }
    return out.sort((a, b) => (b.lastPlayed ?? b.createdAt) - (a.lastPlayed ?? a.createdAt));
  }
  getInstance(id) {
    return this.listInstances().find((i) => i.id === id);
  }
  saveInstance(instance) {
    writeJson(this.instanceFile(instance.id), instance);
  }
};
var store = new Store();

// src/main/langpack.ts
var import_node_fs6 = __toESM(require("node:fs"));
var import_node_path5 = __toESM(require("node:path"));

// src/main/net.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
var ua = { "User-Agent": "WFMC/1.0 (Electron)" };
var AbortError = class extends Error {
  constructor(what = "\u64CD\u4F5C\u5DF2\u53D6\u6D88") {
    super(what);
    this.name = "AbortError";
  }
};
function checkAbort(signal) {
  if (signal?.aborted) throw new AbortError();
}
async function singleStream(u, dest, onProgress, signal, headers = {}) {
  const res = await fetch(u, { headers: { ...ua, ...headers }, signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get("content-length") ?? 0);
  const tmp = `${dest}.part`;
  const out = import_node_fs2.default.createWriteStream(tmp);
  let current = 0;
  const reader = res.body.getReader();
  for (; ; ) {
    checkAbort(signal);
    const { done, value } = await reader.read();
    if (done) break;
    if (value) {
      current += value.byteLength;
      out.write(Buffer.from(value));
      if (total) onProgress?.(current, total);
    }
  }
  await new Promise((resolve, reject) => {
    out.on("error", reject);
    out.on("finish", () => resolve());
    out.end();
  });
  await import_node_fs2.default.promises.rename(tmp, dest);
  if (!total) onProgress?.(current, current);
}
async function chunkedDownload(u, dest, total, onProgress, signal, chunkCount) {
  const tmp = `${dest}.part`;
  const handle = await import_node_fs2.default.promises.open(tmp, "w");
  const size = Math.ceil(total / chunkCount);
  let downloaded = 0;
  const progress = (n) => {
    downloaded += n;
    onProgress?.(downloaded, total);
  };
  try {
    const jobs = [];
    for (let i = 0; i < chunkCount; i++) {
      const start = i * size;
      const end = Math.min(total - 1, start + size - 1);
      if (start > end) break;
      jobs.push(
        (async () => {
          const res = await fetch(u, {
            headers: { ...ua, Range: `bytes=${start}-${end}` },
            signal
          });
          if (res.status !== 206 || !res.body) throw new Error(`\u670D\u52A1\u5668\u4E0D\u652F\u6301\u5206\u7247\uFF08HTTP ${res.status}\uFF09`);
          const reader = res.body.getReader();
          let pos = start;
          for (; ; ) {
            checkAbort(signal);
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              await handle.write(Buffer.from(value), 0, value.byteLength, pos);
              pos += value.byteLength;
              progress(value.byteLength);
            }
          }
        })()
      );
    }
    await Promise.all(jobs);
    await handle.close();
    await import_node_fs2.default.promises.rename(tmp, dest);
  } catch (e) {
    try {
      await handle.close();
    } catch {
    }
    import_node_fs2.default.rmSync(tmp, { force: true });
    throw e;
  }
}
async function downloadFile(url, dest, onProgress, opts = {}) {
  await import_node_fs2.default.promises.mkdir(import_node_path2.default.dirname(dest), { recursive: true });
  checkAbort(opts.signal);
  if (opts.skipIfExists !== false) {
    const stat = await import_node_fs2.default.promises.stat(dest).catch(() => void 0);
    if (stat && stat.size > 0) {
      onProgress?.(stat.size, stat.size);
      return;
    }
  }
  const urls = Array.isArray(url) ? url : [url];
  let lastErr;
  for (const u of urls) {
    checkAbort(opts.signal);
    let total = opts.expectedSize && opts.expectedSize > 0 ? opts.expectedSize : 0;
    if (!total) {
      try {
        const head = await fetch(u, { method: "HEAD", headers: ua, signal: opts.signal });
        total = Number(head.headers.get("content-length") ?? 0) || 0;
      } catch {
      }
    }
    const wantChunks = !opts.noChunk && total >= 4 * 1024 * 1024;
    if (wantChunks) {
      try {
        await chunkedDownload(u, dest, total, onProgress, opts.signal, opts.chunks ?? 4);
        return;
      } catch (e) {
        if (e instanceof AbortError) throw e;
      }
    }
    try {
      await singleStream(u, dest, onProgress, opts.signal);
      return;
    } catch (e) {
      if (e instanceof AbortError) throw e;
      lastErr = e;
    }
  }
  throw lastErr ?? new Error(`\u4E0B\u8F7D\u5931\u8D25: ${url}`);
}

// src/main/options.ts
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
function enableResourcePack(gameDir, zipName, lang = "zh_cn") {
  const file = import_node_path3.default.join(gameDir, "options.txt");
  const entry = `file/${zipName}`;
  try {
    import_node_fs3.default.mkdirSync(gameDir, { recursive: true });
    const text = import_node_fs3.default.existsSync(file) ? import_node_fs3.default.readFileSync(file, "utf-8") : "";
    const lines = text.length > 0 ? text.split(/\r?\n/) : [];
    let packs = ["vanilla"];
    let hasKey = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("resourcePacks:")) continue;
      hasKey = true;
      try {
        const arr = JSON.parse(lines[i].slice("resourcePacks:".length));
        if (Array.isArray(arr)) packs = arr.filter((x) => typeof x === "string");
      } catch {
      }
      if (!packs.includes("vanilla")) packs.unshift("vanilla");
      if (!packs.includes(entry)) packs.push(entry);
      lines[i] = `resourcePacks:${JSON.stringify(packs)}`;
    }
    if (!hasKey) {
      if (!packs.includes(entry)) packs.push(entry);
      lines.push(`resourcePacks:${JSON.stringify(packs)}`);
    }
    let hasLang = false;
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith("lang:")) continue;
      hasLang = true;
      lines[i] = `lang:${lang}`;
    }
    if (!hasLang) lines.push(`lang:${lang}`);
    import_node_fs3.default.writeFileSync(file, lines.filter((l) => l.length > 0).join("\n") + "\n", "utf-8");
    return packs.includes(entry) ? "enabled" : "kept";
  } catch {
    return "kept";
  }
}

// src/main/paths.ts
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));
function gamePathFor(instance) {
  const root = store.instanceGameDir(instance.id);
  if (!instance.isolate) return root;
  const base = instance.mcVersion;
  const target = import_node_path4.default.join(root, "versions", base, "game");
  const legacyVersion = instance.versionId;
  if (legacyVersion && legacyVersion !== base) {
    const legacy = import_node_path4.default.join(root, "versions", legacyVersion, "game");
    if (import_node_fs4.default.existsSync(legacy) && !import_node_fs4.default.existsSync(target)) {
      try {
        import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(target), { recursive: true });
        import_node_fs4.default.renameSync(legacy, target);
      } catch {
      }
    }
  }
  return target;
}

// src/main/zip.ts
var import_node_fs5 = __toESM(require("node:fs"));
var import_node_zlib = __toESM(require("node:zlib"));
var EOCD_SIG = 101010256;
var CEN_SIG = 33639248;
var LOC_SIG = 67324752;
function listZipEntries(buf) {
  let eocd = -1;
  const minPos = Math.max(0, buf.length - 65557);
  for (let i = buf.length - 22; i >= minPos; i--) {
    if (buf.readUInt32LE(i) === EOCD_SIG) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error("\u4E0D\u662F\u6709\u6548\u7684 zip\uFF1A\u627E\u4E0D\u5230\u4E2D\u592E\u76EE\u5F55\u7ED3\u5C3E");
  const entryCount = buf.readUInt16LE(eocd + 10);
  let offset = buf.readUInt32LE(eocd + 16);
  const entries = [];
  for (let i = 0; i < entryCount; i++) {
    if (offset + 46 > buf.length) break;
    if (buf.readUInt32LE(offset) !== CEN_SIG) break;
    const method = buf.readUInt16LE(offset + 10);
    const compressedSize = buf.readUInt32LE(offset + 20);
    const size = buf.readUInt32LE(offset + 24);
    const nameLen = buf.readUInt16LE(offset + 28);
    const extraLen = buf.readUInt16LE(offset + 30);
    const commentLen = buf.readUInt16LE(offset + 32);
    const localOffset = buf.readUInt32LE(offset + 42);
    const name = buf.slice(offset + 46, offset + 46 + nameLen).toString("utf8");
    entries.push({ name, method, compressedSize, size, localOffset, isDirectory: name.endsWith("/") });
    offset += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}
function readZipEntry(buf, entry) {
  const at = entry.localOffset;
  if (buf.readUInt32LE(at) !== LOC_SIG) throw new Error(`\u635F\u574F\u7684 zip \u6761\u76EE: ${entry.name}`);
  const nameLen = buf.readUInt16LE(at + 26);
  const extraLen = buf.readUInt16LE(at + 28);
  const dataStart = at + 30 + nameLen + extraLen;
  const raw = buf.slice(dataStart, dataStart + entry.compressedSize);
  if (entry.method === 0) return raw;
  if (entry.method === 8) return import_node_zlib.default.inflateRawSync(raw);
  throw new Error(`\u4E0D\u652F\u6301\u7684\u538B\u7F29\u65B9\u5F0F ${entry.method}: ${entry.name}`);
}
function readZipFromFile(zipPath) {
  const buf = import_node_fs5.default.readFileSync(zipPath);
  return { buf, entries: listZipEntries(buf) };
}
function readFileInsideZip(zipPath, fileName) {
  const { buf, entries } = readZipFromFile(zipPath);
  const entry = entries.find((e) => e.name === fileName);
  return entry ? readZipEntry(buf, entry) : void 0;
}
var CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
    table[i] = c;
  }
  return table;
})();

// src/main/langpack.ts
var PROJECT = "vmct";
var API = "https://api.modrinth.com/v2";
var UA = { "User-Agent": "WFMC-Launcher/1.0 (Minecraft launcher)" };
var CFPA_REPO = "CFPAOrg/Minecraft-Mod-Language-Package";
var CFPA_MIRRORS = [(u) => `https://gh-proxy.com/${u}`, (u) => `https://ghfast.top/${u}`, (u) => u];
async function getJson(url) {
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(2e4) });
  if (!res.ok) throw new Error(`\u62C9\u53D6\u6C49\u5316\u5305\u5217\u8868\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
  return await res.json();
}
async function pickLangPack(mcVersion) {
  const list = await getJson(`${API}/project/${PROJECT}/version`);
  const scored = list.map((v) => {
    const exact = v.game_versions.includes(mcVersion);
    const covers = v.game_versions.some((g) => g.startsWith(mcVersion.split(".").slice(0, 2).join(".")));
    const file = v.files.find((f) => f.primary) ?? v.files[0];
    return { v, file, exact, covers };
  }).filter((x) => x.file);
  const hit = scored.find((x) => x.exact) ?? scored.find((x) => x.covers) ?? scored[0];
  if (!hit) throw new Error("\u6CA1\u627E\u5230\u53EF\u7528\u7684\u6C49\u5316\u5305");
  return { version: hit.v, file: hit.file, exact: hit.exact };
}
function cfpaSuffix(mcVersion) {
  const m = /^1\.(\d+)/.exec(mcVersion);
  return m ? `1-${m[1]}` : void 0;
}
async function pickCfpa(mcVersion) {
  const suffix = cfpaSuffix(mcVersion);
  if (!suffix) return void 0;
  const res = await fetch(`https://api.github.com/repos/${CFPA_REPO}/releases?per_page=5`, {
    headers: { ...UA, Accept: "application/vnd.github+json" },
    signal: AbortSignal.timeout(2e4)
  });
  if (!res.ok) throw new Error(`\u62C9\u53D6 CFPA \u6C49\u5316\u5305\u5217\u8868\u5931\u8D25\uFF08HTTP ${res.status}\uFF09`);
  const list = await res.json();
  const want = new RegExp(`^Minecraft-Mod-Language-Modpack-${suffix}\\.zip$`, "i");
  for (const rel of list) {
    const hit = rel.assets.find((a) => want.test(a.name));
    if (hit) return { tag: rel.tag_name, name: hit.name, size: hit.size, url: hit.browser_download_url };
  }
  return void 0;
}
async function installLangPacks(instanceId, onProgress) {
  const instance = store.getInstance(instanceId);
  if (!instance) throw new Error("\u5B9E\u4F8B\u4E0D\u5B58\u5728");
  const gameDir = gamePathFor(instance);
  const dir = import_node_path5.default.join(gameDir, "resourcepacks");
  import_node_fs6.default.mkdirSync(dir, { recursive: true });
  const packs = [];
  const skipped = [];
  try {
    onProgress?.({ phase: "\u67E5\u8BE2 VM \u6C49\u5316\u5305\u2026", current: 0, total: 1 });
    const { version, file, exact } = await pickLangPack(instance.mcVersion);
    const dest = import_node_path5.default.join(dir, file.filename);
    onProgress?.({ phase: `\u4E0B\u8F7D ${file.filename}`, current: 0, total: file.size });
    await downloadFile([file.url], dest, (cur, total) => onProgress?.({ phase: `\u4E0B\u8F7D ${file.filename}`, current: cur, total }));
    enableResourcePack(gameDir, import_node_path5.default.basename(dest));
    packs.push({ name: import_node_path5.default.basename(dest), source: "vm", size: import_node_fs6.default.statSync(dest).size, version: version.version_number, exact });
  } catch (e) {
    skipped.push({ source: "VM \u6C49\u5316\u7EC4", reason: e.message });
  }
  try {
    const cf = await pickCfpa(instance.mcVersion);
    if (!cf) {
      skipped.push({ source: "CFPA \u8BED\u8A00\u5305", reason: `\u6CA1\u6709 ${instance.mcVersion} \u5206\u652F\uFF08\u76EE\u524D\u53EA\u51FA 1.21 \u7684\u6574\u5408\u5305\uFF09` });
    } else {
      const dest = import_node_path5.default.join(dir, cf.name);
      onProgress?.({ phase: `\u4E0B\u8F7D ${cf.name}`, current: 0, total: cf.size });
      await downloadFile(
        CFPA_MIRRORS.map((m) => m(cf.url)),
        dest,
        (cur, total) => onProgress?.({ phase: `\u4E0B\u8F7D ${cf.name}`, current: cur, total })
      );
      const got = import_node_fs6.default.statSync(dest).size;
      if (cf.size && got !== cf.size) throw new Error(`\u4E0B\u8F7D\u4E0D\u5B8C\u6574\uFF08${got} / ${cf.size} \u5B57\u8282\uFF09\uFF0C\u91CD\u8BD5\u4E00\u6B21`);
      enableResourcePack(gameDir, import_node_path5.default.basename(dest));
      packs.push({ name: import_node_path5.default.basename(dest), source: "cfpa", size: got, version: cf.tag, exact: true });
    }
  } catch (e) {
    skipped.push({ source: "CFPA \u8BED\u8A00\u5305", reason: e.message });
  }
  if (!packs.length) throw new Error(`\u6C49\u5316\u5305\u90FD\u6CA1\u88C5\u4E0A\uFF1A${skipped.map((s) => `${s.source} ${s.reason}`).join("\uFF1B")}`);
  onProgress?.({ phase: `\u5DF2\u88C5\u597D ${packs.length} \u4E2A\u6C49\u5316\u5305\u5E76\u542F\u7528`, current: packs.length, total: packs.length });
  return { packs, skipped };
}
function inspectLangPack(instanceId) {
  const instance = store.getInstance(instanceId);
  if (!instance) throw new Error("\u5B9E\u4F8B\u4E0D\u5B58\u5728");
  const gameDir = gamePathFor(instance);
  const rpDir = import_node_path5.default.join(gameDir, "resourcepacks");
  const packs = [];
  const covered = /* @__PURE__ */ new Set();
  if (import_node_fs6.default.existsSync(rpDir)) {
    for (const z of import_node_fs6.default.readdirSync(rpDir)) {
      if (!z.toLowerCase().endsWith(".zip")) continue;
      try {
        const buf = import_node_fs6.default.readFileSync(import_node_path5.default.join(rpDir, z));
        const ids = /* @__PURE__ */ new Set();
        for (const e of listZipEntries(buf)) {
          const m = /^assets\/([^/]+)\/lang\/zh_cn\.json$/i.exec(e.name);
          if (m) ids.add(m[1].toLowerCase());
        }
        if (!ids.size) continue;
        packs.push({ name: z, count: ids.size });
        ids.forEach((i) => covered.add(i));
      } catch {
      }
    }
  }
  packs.sort((a, b) => b.count - a.count);
  const modsDir = import_node_path5.default.join(gameDir, "mods");
  const mods = [];
  if (import_node_fs6.default.existsSync(modsDir)) {
    for (const f of import_node_fs6.default.readdirSync(modsDir)) {
      if (!/\.jar(\.disabled)?$/i.test(f)) continue;
      const jar = import_node_path5.default.join(modsDir, f);
      let id = "";
      let name = f.replace(/\.jar(\.disabled)?$/i, "");
      try {
        const raw = readFileInsideZip(jar, "fabric.mod.json");
        if (raw) {
          const j = JSON.parse(raw.toString("utf8"));
          id = String(j.id ?? "").toLowerCase();
          if (j.name) name = j.name;
        } else {
          const raw2 = readFileInsideZip(jar, "META-INF/neoforge.mods.toml") ?? readFileInsideZip(jar, "META-INF/mods.toml");
          if (raw2) {
            const txt = raw2.toString("utf8");
            const m = /^\s*modId\s*=\s*"([^"]+)"/m.exec(txt);
            const d = /^\s*displayName\s*=\s*"([^"]+)"/m.exec(txt);
            if (m) id = m[1].toLowerCase();
            if (d) name = d[1];
          }
        }
      } catch {
      }
      if (!id) continue;
      let selfChinese = false;
      try {
        selfChinese = !!readFileInsideZip(jar, `assets/${id}/lang/zh_cn.json`);
      } catch {
        selfChinese = false;
      }
      mods.push({ id, name, covered: covered.has(id), selfChinese });
    }
  }
  return { packs, coveredCount: covered.size, mods };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  inspectLangPack,
  installLangPacks,
  store
});

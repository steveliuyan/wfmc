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

// .tmp-app/entry2.ts
var entry2_exports = {};
__export(entry2_exports, {
  gamePathFor: () => gamePathFor,
  inspectLangPack: () => inspectLangPack,
  store: () => store
});
module.exports = __toCommonJS(entry2_exports);

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
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));

// src/main/paths.ts
var import_node_fs2 = __toESM(require("node:fs"));
var import_node_path2 = __toESM(require("node:path"));
function gamePathFor(instance) {
  const root = store.instanceGameDir(instance.id);
  if (!instance.isolate) return root;
  const base = instance.mcVersion;
  const target = import_node_path2.default.join(root, "versions", base, "game");
  const legacyVersion = instance.versionId;
  if (legacyVersion && legacyVersion !== base) {
    const legacy = import_node_path2.default.join(root, "versions", legacyVersion, "game");
    if (import_node_fs2.default.existsSync(legacy) && !import_node_fs2.default.existsSync(target)) {
      try {
        import_node_fs2.default.mkdirSync(import_node_path2.default.dirname(target), { recursive: true });
        import_node_fs2.default.renameSync(legacy, target);
      } catch {
      }
    }
  }
  return target;
}

// src/main/zip.ts
var import_node_fs3 = __toESM(require("node:fs"));
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
  const buf = import_node_fs3.default.readFileSync(zipPath);
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
function inspectLangPack(instanceId) {
  const instance = store.getInstance(instanceId);
  if (!instance) throw new Error("\u5B9E\u4F8B\u4E0D\u5B58\u5728");
  const gameDir = gamePathFor(instance);
  const rpDir = import_node_path3.default.join(gameDir, "resourcepacks");
  const packs = [];
  const covered = /* @__PURE__ */ new Set();
  if (import_node_fs4.default.existsSync(rpDir)) {
    for (const z of import_node_fs4.default.readdirSync(rpDir)) {
      if (!z.toLowerCase().endsWith(".zip")) continue;
      try {
        const buf = import_node_fs4.default.readFileSync(import_node_path3.default.join(rpDir, z));
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
  const modsDir = import_node_path3.default.join(gameDir, "mods");
  const mods = [];
  if (import_node_fs4.default.existsSync(modsDir)) {
    for (const f of import_node_fs4.default.readdirSync(modsDir)) {
      if (!/\.jar(\.disabled)?$/i.test(f)) continue;
      const jar = import_node_path3.default.join(modsDir, f);
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
  gamePathFor,
  inspectLangPack,
  store
});

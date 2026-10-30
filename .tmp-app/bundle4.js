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

// .tmp-app/entry4.ts
var entry4_exports = {};
__export(entry4_exports, {
  gamePathFor: () => gamePathFor,
  inspectWorldPack: () => inspectWorldPack,
  packWorld: () => packWorld,
  restoreWorldPack: () => restoreWorldPack,
  store: () => store,
  zip: () => zip_exports
});
module.exports = __toCommonJS(entry4_exports);

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

// src/main/worldpack.ts
var import_node_crypto = __toESM(require("node:crypto"));
var import_node_fs4 = __toESM(require("node:fs"));
var import_node_path4 = __toESM(require("node:path"));

// src/main/zip.ts
var zip_exports = {};
__export(zip_exports, {
  collectDirFiles: () => collectDirFiles,
  crc32: () => crc32,
  extractZipPrefixes: () => extractZipPrefixes,
  listZipEntries: () => listZipEntries,
  readFileInsideZip: () => readFileInsideZip,
  readZipEntry: () => readZipEntry,
  readZipFromFile: () => readZipFromFile,
  writeZip: () => writeZip,
  writeZipCompressed: () => writeZipCompressed,
  zipDirectory: () => zipDirectory
});
var import_node_fs3 = __toESM(require("node:fs"));
var import_node_path3 = __toESM(require("node:path"));
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
async function extractZipPrefixes(zipPath, prefixes, destRoot) {
  const { buf, entries } = readZipFromFile(zipPath);
  let count = 0;
  for (const entry of entries) {
    if (entry.isDirectory) continue;
    const matched = prefixes.find((p) => entry.name.startsWith(p));
    if (!matched) continue;
    const relative = entry.name.slice(matched.length);
    if (!relative) continue;
    const dest = import_node_path3.default.join(destRoot, relative);
    await import_node_fs3.default.promises.mkdir(import_node_path3.default.dirname(dest), { recursive: true });
    await import_node_fs3.default.promises.writeFile(dest, readZipEntry(buf, entry));
    count++;
  }
  return count;
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
function crc32(buf) {
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = crc >>> 8 ^ CRC_TABLE[(crc ^ buf[i]) & 255];
  return (crc ^ -1) >>> 0;
}
function collectDirFiles(root, prefix = "") {
  const out = [];
  const walk = (dir, rel) => {
    let items;
    try {
      items = import_node_fs3.default.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const item of items) {
      const full = import_node_path3.default.join(dir, item.name);
      const name = rel ? `${rel}/${item.name}` : item.name;
      if (item.isDirectory()) {
        walk(full, name);
      } else {
        try {
          out.push({ name, full, size: import_node_fs3.default.statSync(full).size });
        } catch {
        }
      }
    }
  };
  if (prefix) walk(root, prefix);
  else walk(root, "");
  return out;
}
function writeZip(outputPath, files) {
  import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(outputPath), { recursive: true });
  const fd = import_node_fs3.default.openSync(outputPath, "w");
  const central = [];
  let offset = 0;
  let count = 0;
  for (const file of files) {
    let data;
    try {
      data = import_node_fs3.default.readFileSync(file.full);
    } catch {
      continue;
    }
    const nameBuf = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(0, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    import_node_fs3.default.writeSync(fd, local);
    import_node_fs3.default.writeSync(fd, nameBuf);
    import_node_fs3.default.writeSync(fd, data);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(2048, 8);
    cen.writeUInt16LE(0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(data.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + data.length;
    count++;
  }
  const cenStart = offset;
  let cenSize = 0;
  for (const buf of central) {
    import_node_fs3.default.writeSync(fd, buf);
    cenSize += buf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cenSize, 12);
  eocd.writeUInt32LE(cenStart, 16);
  eocd.writeUInt16LE(0, 20);
  import_node_fs3.default.writeSync(fd, eocd);
  import_node_fs3.default.closeSync(fd);
  return count;
}
function zipDirectory(dir, outputPath) {
  const files = collectDirFiles(dir);
  return writeZip(outputPath, files);
}
function writeZipCompressed(outputPath, files, onEach) {
  import_node_fs3.default.mkdirSync(import_node_path3.default.dirname(outputPath), { recursive: true });
  const fd = import_node_fs3.default.openSync(outputPath, "w");
  const central = [];
  let offset = 0;
  let count = 0;
  const total = files.length;
  for (const file of files) {
    let raw;
    try {
      raw = import_node_fs3.default.readFileSync(file.full);
    } catch {
      continue;
    }
    const crc = crc32(raw);
    let method = 0;
    let body = raw;
    try {
      const packed = import_node_zlib.default.deflateRawSync(raw, { level: 6 });
      if (packed.length < raw.length) {
        method = 8;
        body = packed;
      }
    } catch {
    }
    const nameBuf = Buffer.from(file.name.replace(/\\/g, "/"), "utf8");
    const local = Buffer.alloc(30);
    local.writeUInt32LE(LOC_SIG, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(2048, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    import_node_fs3.default.writeSync(fd, local);
    import_node_fs3.default.writeSync(fd, nameBuf);
    import_node_fs3.default.writeSync(fd, body);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(CEN_SIG, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(2048, 8);
    cen.writeUInt16LE(method, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(body.length, 20);
    cen.writeUInt32LE(raw.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + body.length;
    count++;
    if (onEach) onEach(file.name, count, total);
  }
  const cenStart = offset;
  let cenSize = 0;
  for (const buf of central) {
    import_node_fs3.default.writeSync(fd, buf);
    cenSize += buf.length;
  }
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(EOCD_SIG, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(count, 8);
  eocd.writeUInt16LE(count, 10);
  eocd.writeUInt32LE(cenSize, 12);
  eocd.writeUInt32LE(cenStart, 16);
  eocd.writeUInt16LE(0, 20);
  import_node_fs3.default.writeSync(fd, eocd);
  import_node_fs3.default.closeSync(fd);
  return count;
}

// src/main/worldpack.ts
var PACK_MANIFEST = "wfmc-worldpack.json";
var PACK_PREFIX = "world/";
var PACK_FORMAT = 1;
var MAX_PACK_BYTES = 1536 * 1024 * 1024;
function sha1Of(buf) {
  return import_node_crypto.default.createHash("sha1").update(buf).digest("hex");
}
function sha1OfFile(file) {
  return sha1Of(import_node_fs4.default.readFileSync(file));
}
function fmtMB(n) {
  return (n / 1024 / 1024).toFixed(1) + " MB";
}
function savesDirOf(instanceId) {
  const instance = store.getInstance(instanceId);
  if (!instance) throw new Error("\u5B9E\u4F8B\u4E0D\u5B58\u5728");
  return { mcVersion: instance.mcVersion, dir: import_node_path4.default.join(gamePathFor(instance), "saves") };
}
function digestOf(entries) {
  const text = entries.slice().sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0).map((e) => `${e.path}|${e.size}|${e.sha1}`).join("\n");
  return sha1Of(Buffer.from(text, "utf8"));
}
function safeWorldName(name) {
  return (name || "world").replace(/[\\/:*?"<>|]+/g, "_").replace(/^\.+/, "").slice(0, 80) || "world";
}
function packWorld(instanceId, world, outPath, onProgress) {
  const { mcVersion, dir } = savesDirOf(instanceId);
  const src = import_node_path4.default.join(dir, world);
  if (!import_node_fs4.default.existsSync(src) || !import_node_fs4.default.statSync(src).isDirectory()) throw new Error(`\u627E\u4E0D\u5230\u5B58\u6863\uFF1A${world}`);
  const files = collectDirFiles(src);
  if (files.length === 0) throw new Error("\u8FD9\u4E2A\u5B58\u6863\u76EE\u5F55\u662F\u7A7A\u7684");
  const entries = [];
  let bytes = 0;
  files.forEach((f, i) => {
    const sha1 = sha1OfFile(f.full);
    entries.push({ path: f.name, size: f.size, sha1 });
    bytes += f.size;
    if (i % 25 === 0) onProgress?.({ phase: `\u8BFB\u53D6\u5E76\u6821\u9A8C ${f.name}`, current: i + 1, total: files.length });
  });
  const info = {
    format: PACK_FORMAT,
    app: "WFMC",
    name: world,
    mcVersion,
    createdAt: Date.now(),
    fileCount: entries.length,
    bytes,
    digest: digestOf(entries)
  };
  const tmp = import_node_path4.default.join(store.backupsDir, `.${Date.now()}-${PACK_MANIFEST}`);
  import_node_fs4.default.mkdirSync(store.backupsDir, { recursive: true });
  import_node_fs4.default.writeFileSync(tmp, JSON.stringify({ ...info, entries }), "utf8");
  try {
    const items = [
      { name: PACK_MANIFEST, full: tmp },
      ...files.map((f) => ({ name: PACK_PREFIX + f.name, full: f.full }))
    ];
    writeZipCompressed(outPath, items, (name, done, total) => {
      if (done % 25 === 0 || done === total) onProgress?.({ phase: `\u6253\u5305 ${name}`, current: done, total });
    });
  } finally {
    try {
      import_node_fs4.default.unlinkSync(tmp);
    } catch {
    }
  }
  return { path: outPath, info, zipBytes: import_node_fs4.default.statSync(outPath).size };
}
function parsePack(zipPath) {
  const size = import_node_fs4.default.statSync(zipPath).size;
  if (size > MAX_PACK_BYTES) {
    throw new Error(`\u8FD9\u4E2A\u5305\u6709 ${fmtMB(size)}\uFF0C\u592A\u5927\u4E86\uFF0C\u5148\u5728\u89E3\u538B\u8F6F\u4EF6\u91CC\u89E3\u5F00\u518D\u653E\u8FDB saves`);
  }
  const { buf, entries } = readZipFromFile(zipPath);
  const data = /* @__PURE__ */ new Map();
  for (const e of entries) {
    if (e.isDirectory) continue;
    data.set(e.name, readZipEntry(buf, e));
  }
  const problems = [];
  const manifestBuf = data.get(PACK_MANIFEST);
  if (!manifestBuf) {
    const plain = [...data.keys()].filter((n) => !n.startsWith(PACK_PREFIX));
    return {
      buf,
      data,
      check: {
        ok: true,
        signed: false,
        checked: data.size,
        problems: plain.length ? [{ path: plain[0], kind: "unsafe", detail: "\u5305\u91CC\u6CA1\u6709 WFMC \u6821\u9A8C\u6E05\u5355\uFF0C\u65E0\u6CD5\u9010\u6587\u4EF6\u6838\u5BF9" }] : []
      }
    };
  }
  let parsed;
  try {
    parsed = JSON.parse(manifestBuf.toString("utf8"));
  } catch {
    return {
      buf,
      data,
      check: {
        ok: false,
        signed: false,
        checked: 0,
        problems: [{ path: PACK_MANIFEST, kind: "sha1", detail: "\u6E05\u5355\u6587\u4EF6\u574F\u4E86\uFF08\u4E0D\u662F\u5408\u6CD5 JSON\uFF09" }]
      }
    };
  }
  const info = { ...parsed };
  const list = Array.isArray(parsed.entries) ? parsed.entries ?? [] : [];
  delete info.entries;
  if (info.format !== PACK_FORMAT) {
    problems.push({
      path: PACK_MANIFEST,
      kind: "unsafe",
      detail: `\u6E05\u5355\u683C\u5F0F\u662F ${info.format}\uFF0C\u8FD9\u4E2A\u7248\u672C\u53EA\u8BA4 ${PACK_FORMAT}`
    });
  }
  if (info.digest && info.digest !== digestOf(list)) {
    problems.push({ path: PACK_MANIFEST, kind: "sha1", detail: "\u603B\u6307\u7EB9\u5BF9\u4E0D\u4E0A\uFF0C\u5305\u88AB\u6539\u8FC7\u6216\u6CA1\u5199\u5B8C" });
  }
  let checked = 0;
  for (const item of list) {
    if (item.path.includes("..") || import_node_path4.default.isAbsolute(item.path)) {
      problems.push({ path: item.path, kind: "unsafe", detail: "\u8DEF\u5F84\u8D8A\u754C\uFF0C\u5DF2\u62D2\u7EDD" });
      continue;
    }
    const raw = data.get(PACK_PREFIX + item.path);
    if (!raw) {
      problems.push({ path: item.path, kind: "missing" });
      continue;
    }
    if (raw.length !== item.size) {
      problems.push({ path: item.path, kind: "size", detail: `${raw.length} \u2260 ${item.size}` });
      continue;
    }
    const got = sha1Of(raw);
    if (got !== item.sha1) {
      problems.push({ path: item.path, kind: "sha1", detail: `${got.slice(0, 8)} \u2260 ${item.sha1.slice(0, 8)}` });
      continue;
    }
    checked++;
  }
  return {
    buf,
    data,
    manifest: { info, entries: list },
    check: { ok: problems.length === 0, signed: true, info, checked, problems }
  };
}
function inspectWorldPack(zipPath) {
  if (!import_node_fs4.default.existsSync(zipPath)) throw new Error("\u627E\u4E0D\u5230\u8FD9\u4E2A\u6587\u4EF6");
  return parsePack(zipPath).check;
}
function restoreWorldPack(instanceId, zipPath, onProgress) {
  const { dir } = savesDirOf(instanceId);
  const pack = parsePack(zipPath);
  const { check } = pack;
  if (!check.ok) {
    const head = check.problems.slice(0, 5).map((p) => `${p.path}\uFF08${p.kind}${p.detail ? " " + p.detail : ""}\uFF09`).join("\uFF1B");
    const more = check.problems.length > 5 ? ` \u7B49 ${check.problems.length} \u4E2A\u95EE\u9898` : "";
    throw new Error(`\u6821\u9A8C\u6CA1\u901A\u8FC7\uFF0C\u4E00\u4E2A\u6587\u4EF6\u90FD\u6CA1\u52A8\uFF1A${head}${more}`);
  }
  const baseName = safeWorldName(
    check.info?.name ?? import_node_path4.default.basename(zipPath).replace(/\.wfmcworld\.zip$|\.zip$/i, "")
  );
  let name = baseName;
  let renamed = false;
  if (import_node_fs4.default.existsSync(import_node_path4.default.join(dir, name))) {
    const d = /* @__PURE__ */ new Date();
    const p = (n) => String(n).padStart(2, "0");
    name = `${baseName} (\u6062\u590D ${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())})`;
    renamed = true;
  }
  const dest = import_node_path4.default.join(dir, name);
  const items = [];
  if (check.info) {
    const missing = (check.info.fileCount ?? 0) - (pack.manifest?.entries.length ?? 0);
    if (missing !== 0) throw new Error("\u6E05\u5355\u91CC\u7684\u6587\u4EF6\u6570\u548C\u6761\u76EE\u6570\u5BF9\u4E0D\u4E0A\uFF0C\u5305\u53EF\u80FD\u88AB\u622A\u65AD");
    for (const item of pack.manifest?.entries ?? []) {
      const raw = pack.data.get(PACK_PREFIX + item.path);
      if (!raw) throw new Error(`\u5305\u91CC\u7F3A ${item.path}`);
      items.push([item.path, raw]);
    }
  } else {
    for (const [n, raw] of pack.data) {
      if (n === PACK_MANIFEST) continue;
      items.push([n.startsWith(PACK_PREFIX) ? n.slice(PACK_PREFIX.length) : n, raw]);
    }
  }
  if (items.length === 0) throw new Error("\u5305\u91CC\u6CA1\u6709\u53EF\u6062\u590D\u7684\u6587\u4EF6");
  import_node_fs4.default.mkdirSync(dest, { recursive: true });
  let bytes = 0;
  items.forEach(([rel, raw], i) => {
    const target = import_node_path4.default.join(dest, ...rel.split("/"));
    const safe = import_node_path4.default.resolve(target).startsWith(import_node_path4.default.resolve(dest) + import_node_path4.default.sep);
    if (!safe) throw new Error(`\u5305\u91CC\u6709\u4E2A\u8DEF\u5F84\u4E0D\u5408\u6CD5\uFF1A${rel}`);
    import_node_fs4.default.mkdirSync(import_node_path4.default.dirname(target), { recursive: true });
    import_node_fs4.default.writeFileSync(target, raw);
    bytes += raw.length;
    if (i % 25 === 0) onProgress?.({ phase: `\u5199\u5165 ${rel}`, current: i + 1, total: items.length });
  });
  return {
    dir: dest,
    name,
    fileCount: items.length,
    bytes,
    renamed,
    check
  };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  gamePathFor,
  inspectWorldPack,
  packWorld,
  restoreWorldPack,
  store,
  zip
});

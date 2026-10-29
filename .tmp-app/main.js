"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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

// .tmp-icon.ts
var import_node_fs = __toESM(require("node:fs"));
var import_electron = require("electron");
var out = (s) => import_node_fs.default.appendFileSync("H:/mcqidongqi/.tmp-java-test.log", s + "\n");
var bigIcon = () => {
  const p = "H:/mcqidongqi/build/icon.png";
  if (!import_node_fs.default.existsSync(p)) return void 0;
  const img = import_electron.nativeImage.createFromPath(p).resize({ width: 128, height: 128, quality: "best" });
  return img.isEmpty() ? void 0 : img;
};
async function main() {
  await import_electron.app.whenReady();
  import_node_fs.default.writeFileSync("H:/mcqidongqi/.tmp-java-test.log", "");
  const img = bigIcon();
  out("icon ok=" + !!img + " size=" + (img ? JSON.stringify(img.getSize()) : "none"));
  process.exit(0);
}
main();

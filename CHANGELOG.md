# WFMC 1.0.22

这一版解决一件具体的事：**装了加载器，模组还是不加载，而且不知道该怎么办。**

## 1. 一键换成模组需要的加载器

场景：实例是 Forge / NeoForge / 原版，`mods` 里放的却是 Fabric 模组。启动器以前只在体检里说「加载器不匹配」，等于把问题丢回给你。

现在体检结果里那条错误会直接带一个按钮 **「换成 Fabric 加载器」**：

- 点一下自动拉最新的 Fabric 版本 → 装好 → 自动把启动版本切过去；
- 存档 / mods / config 都不动，原来的 Forge 版本文件也留着，想切回来随时切。

## 2. 启动时日志也说明白

以前只有「原版实例 + 有 mods」才写一行提示。现在只要是加载器对不上的情况，启动日志里都会有一句：

```
[WFMC] 注意：1 个 mod 是给 fabric 用的，当前实例是 neoforge，启动时它们会被直接忽略……
```

不用再对着「进游戏没有模组」猜原因。

## 3. 顺手说清「为什么装了 Forge 还是没模组」

Fabric 和 Forge / NeoForge 的模组格式不通用：

| 你的模组 | 需要的加载器 |
|---|---|
| 有 `fabric.mod.json` 的 | Fabric（或 Quilt） |
| 有 `META-INF/mods.toml` 的 | Forge |
| 有 `META-INF/neoforge.mods.toml` 的 | NeoForge |

装 Forge 只能加载 Forge 模组。要玩 Fabric 模组，就得换 Fabric 加载器 —— 现在一个按钮的事。

另外注意：`Fabric API` 这种前置模组**必须处于启用状态**（文件名带 `.jar` 而不是 `.jar.disabled`），否则依赖它的模组（比如 Lucky Blocks）一样不会加载。

## 4. 验证

- `npx tsc --noEmit` 0 错误；`npm run build` 通过；
- 内容管理 → 体检模组：错误条目下出现「换成 Fabric 加载器」按钮 + 「装完自动切过去，存档 / mods 都不动」；
- 加载器面板仍可手动选任意加载器/版本，也可以「切回原版」。

## 下载

| 版本 | 文件 | 大小 |
|---|---|---|
| 便携版 | `WFMC-Portable-1.0.22.exe` | 92.2 MB |
| 安装版 | `WFMC-Setup-1.0.22.exe` | 92.4 MB |

安装版支持自选安装目录；便携版解压即用，数据存在程序旁的 `WFMC-Data`。

---

之前版本（1.0.21 及更早）的说明见 <https://github.com/steveliuyan/wfmc/releases>
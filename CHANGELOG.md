# WFMC 1.0.23

这一版解决：**模组装上了，但界面里全是英文。**

## 1. 为什么模组内容是英文的

模组的中文不是启动器能"翻"的——它是模组作者写在 jar 里的 `assets/<modid>/lang/zh_cn.json`。作者只写了 `en_us.json`，游戏里就是英文；这跟启动器语言设置无关，改游戏语言也没用。

国内各行启动器的标准做法都一样：**装一个汉化资源包**。资源包的加载优先级比模组内置语言高，所以中文会盖住原来的英文条目，模组名、物品说明、任务文本一起变中文。

## 2. 一键装汉化包

内容管理 → 模组（或资源包）页的工具栏里多了一个按钮 **「装中文汉化包」**：

- 数据源是 [VM 汉化组](https://github.com/VM-Chinese-translate-group/mod-standard-translation-repository) 维护的通用汉化包，覆盖 1.12.2 / 1.16.x / 1.18.x / 1.19 ~ 1.21.11；
- 点一下：自动挑跟你实例 MC 版本匹配的那一版 → 下到 `resourcepacks/` → 写进 `options.txt` 的 `resourcePacks` 列表并启用 → 顺手把 `lang` 设成 `zh_cn`；
- 这个 MC 版本没有专门的包时，会用通用版并在提示里说明；
- 卸载就是把 `resourcepacks` 里那个 zip 删掉（或者在列表里点「禁用」）。

实测（1.21.11）：下载 `VM汉化组模组汉化包1.19及以上.zip`（779 KB，版本号 20260216），`options.txt` 写成：

```
resourcePacks:["vanilla","file/VM汉化组模组汉化包1.19及以上.zip"]
lang:zh_cn
```

## 3. 顺带说清一件事

游戏语言（`options.txt` 的 `lang`）和模组语言（jar 里的 `lang/zh_cn.json`）是两套东西。启动器从 1.0.13 起会在新建实例时把游戏语言设成简体中文，但那管不到模组文本——模组文本只认汉化包。

## 下载

| 版本 | 文件 | 大小 |
| --- | --- | --- |
| 便携版 | `WFMC-Portable-1.0.23.exe` | 92.2 MB |
| 安装版 | `WFMC-Setup-1.0.23.exe` | 92.4 MB |

完整版本列表见 [Releases](https://github.com/steveliuyan/wfmc/releases)。

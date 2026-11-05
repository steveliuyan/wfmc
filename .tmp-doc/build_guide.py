# -*- coding: utf-8 -*-
"""生成《WFMC 新手操作手册》Word 文档。"""
import os
import re
from docx import Document
from docx.shared import Pt, Cm, RGBColor, Emu
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_LINE_SPACING
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.section import WD_SECTION
from docx.oxml.ns import qn
from docx.oxml import OxmlElement

SHOT = r"H:\mcqidongqi\.tmp-shot"
OUT = r"H:\mcqidongqi\docs\WFMC-新手操作手册.docx"

ACCENT = RGBColor(0x4B, 0x47, 0xC0)
ACCENT_HEX = "4B47C0"
DARK = RGBColor(0x1F, 0x21, 0x33)
GRAY = RGBColor(0x6B, 0x70, 0x85)
LIGHT_FILL = "F2F3FB"
WARN_FILL = "FFF6E6"
WARN_HEX = "E0A020"
OK_FILL = "EFF8F1"
OK_HEX = "3B9E5A"
HEADER_FILL = ACCENT_HEX

BODY_FONT_CN = "宋体"
BODY_FONT_EN = "Calibri"
HEAD_FONT_CN = "微软雅黑"
MONO_FONT = "Consolas"

doc = Document()

# ---------- 页面与基础样式 ----------
sec = doc.sections[0]
sec.page_width = Cm(21.0)
sec.page_height = Cm(29.7)
sec.left_margin = Cm(2.3)
sec.right_margin = Cm(2.3)
sec.top_margin = Cm(2.4)
sec.bottom_margin = Cm(2.2)

normal = doc.styles["Normal"]
normal.font.name = BODY_FONT_EN
normal.font.size = Pt(10.5)
normal.element.rPr.rFonts.set(qn("w:eastAsia"), BODY_FONT_CN)
normal.paragraph_format.line_spacing_rule = WD_LINE_SPACING.MULTIPLE
normal.paragraph_format.line_spacing = 1.45
normal.paragraph_format.space_after = Pt(6)


def _set_run_font(run, cn=BODY_FONT_CN, en=BODY_FONT_EN, size=None, bold=None, color=None, italic=None):
    run.font.name = en
    rpr = run._element.get_or_add_rPr()
    rf = rpr.find(qn("w:rFonts"))
    if rf is None:
        rf = OxmlElement("w:rFonts")
        rpr.insert(0, rf)
    rf.set(qn("w:ascii"), en)
    rf.set(qn("w:hAnsi"), en)
    rf.set(qn("w:eastAsia"), cn)
    if size is not None:
        run.font.size = Pt(size)
    if bold is not None:
        run.font.bold = bold
    if italic is not None:
        run.font.italic = italic
    if color is not None:
        run.font.color.rgb = color


TOKEN = re.compile(r"(\*\*.+?\*\*|`.+?`)")


def fill_para(p, text, size=10.5, color=None, cn=BODY_FONT_CN, en=BODY_FONT_EN, bold=False):
    """支持 **加粗** 与 `等宽` 两种行内标记。"""
    for part in TOKEN.split(text):
        if not part:
            continue
        if part.startswith("**") and part.endswith("**"):
            r = p.add_run(part[2:-2])
            _set_run_font(r, cn, en, size, True, color)
        elif part.startswith("`") and part.endswith("`"):
            r = p.add_run(part[1:-1])
            _set_run_font(r, MONO_FONT, MONO_FONT, size - 0.5, bold, RGBColor(0x33, 0x33, 0x33))
        else:
            r = p.add_run(part)
            _set_run_font(r, cn, en, size, bold, color)
    return p


def P(text, size=10.5, space_before=0, space_after=6, first_indent=None, align=None, color=None):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(space_before)
    pf.space_after = Pt(space_after)
    if first_indent is not None:
        pf.first_line_indent = Cm(first_indent)
    if align is not None:
        p.alignment = align
    fill_para(p, text, size=size, color=color)
    return p


def P_lead(text, size=10.5):
    """章首导语：稍大、有底色、左侧竖线。"""
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(2)
    pf.space_after = Pt(10)
    pf.left_indent = Cm(0.3)
    pf.right_indent = Cm(0.2)
    fill_para(p, text, size=size, color=RGBColor(0x3A, 0x3D, 0x52))
    pPr = p._element.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), LIGHT_FILL)
    pPr.append(shd)
    bdr = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "6")
    left.set(qn("w:color"), ACCENT_HEX)
    bdr.append(left)
    pPr.append(bdr)
    return p


def _bottom_border(p, color=ACCENT_HEX, sz="12"):
    pPr = p._element.get_or_add_pPr()
    bdr = OxmlElement("w:pBdr")
    bottom = OxmlElement("w:bottom")
    bottom.set(qn("w:val"), "single")
    bottom.set(qn("w:sz"), sz)
    bottom.set(qn("w:space"), "4")
    bottom.set(qn("w:color"), color)
    bdr.append(bottom)
    pPr.append(bdr)


def H1(number, title):
    doc.add_page_break()
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(0)
    pf.space_after = Pt(4)
    pf.keep_with_next = True
    r = p.add_run(number)
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 11, True, RGBColor(0x8C, 0x89, 0xD8))
    r2 = p.add_run("    " + title)
    _set_run_font(r2, HEAD_FONT_CN, HEAD_FONT_CN, 19, True, ACCENT)
    _bottom_border(p)
    return p


def H2(text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(14)
    pf.space_after = Pt(5)
    pf.keep_with_next = True
    r = p.add_run(text)
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 13.5, True, DARK)
    return p


def H3(text):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(9)
    pf.space_after = Pt(3)
    pf.keep_with_next = True
    r = p.add_run(text)
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 11.5, True, RGBColor(0x2C, 0x2F, 0x45))
    return p


def BULLET(text, size=10.5, indent=0.55):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(indent + 0.45)
    pf.first_line_indent = Cm(-0.45)
    pf.space_before = Pt(0)
    pf.space_after = Pt(3)
    r = p.add_run("· ")
    _set_run_font(r, BODY_FONT_CN, BODY_FONT_EN, size, True, ACCENT)
    fill_para(p, text, size=size)
    return p


def NUM(idx, text, size=10.5):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.left_indent = Cm(1.0)
    pf.first_line_indent = Cm(-1.0)
    pf.space_before = Pt(0)
    pf.space_after = Pt(4)
    r = p.add_run(f"  {idx}.  ")
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, size, True, ACCENT)
    fill_para(p, text, size=size)
    return p


def _box(paras_fill, hexcolor):
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(6)
    pf.space_after = Pt(10)
    pf.left_indent = Cm(0.3)
    pf.right_indent = Cm(0.2)
    pPr = p._element.get_or_add_pPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), paras_fill)
    pPr.append(shd)
    bdr = OxmlElement("w:pBdr")
    left = OxmlElement("w:left")
    left.set(qn("w:val"), "single")
    left.set(qn("w:sz"), "18")
    left.set(qn("w:space"), "6")
    left.set(qn("w:color"), hexcolor)
    bdr.append(left)
    pPr.append(bdr)
    return p


def TIP(title, text):
    p = _box(LIGHT_FILL, ACCENT_HEX)
    r = p.add_run(title + "　")
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 10, True, ACCENT)
    fill_para(p, text, size=10)
    return p


def WARN(title, text):
    p = _box(WARN_FILL, WARN_HEX)
    r = p.add_run(title + "　")
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 10, True, RGBColor(0xB0, 0x72, 0x00))
    fill_para(p, text, size=10)
    return p


def OKBOX(title, text):
    p = _box(OK_FILL, OK_HEX)
    r = p.add_run(title + "　")
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 10, True, RGBColor(0x2C, 0x7A, 0x46))
    fill_para(p, text, size=10)
    return p


def _shade_cell(cell, hexfill):
    tcPr = cell._tc.get_or_add_tcPr()
    shd = OxmlElement("w:shd")
    shd.set(qn("w:val"), "clear")
    shd.set(qn("w:color"), "auto")
    shd.set(qn("w:fill"), hexfill)
    tcPr.append(shd)


def TABLE(headers, rows, widths=None, size=9.5, header_fill=HEADER_FILL, zebra=True):
    t = doc.add_table(rows=1, cols=len(headers))
    t.style = "Table Grid"
    t.alignment = WD_TABLE_ALIGNMENT.CENTER
    t.autofit = False
    hdr = t.rows[0].cells
    for i, h in enumerate(headers):
        _shade_cell(hdr[i], header_fill)
        para = hdr[i].paragraphs[0]
        para.paragraph_format.space_before = Pt(3)
        para.paragraph_format.space_after = Pt(3)
        para.paragraph_format.line_spacing = 1.15
        r = para.add_run(h)
        _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, size, True, RGBColor(0xFF, 0xFF, 0xFF))
    for ri, row in enumerate(rows):
        cells = t.add_row().cells
        for i, val in enumerate(row):
            if zebra and ri % 2 == 1:
                _shade_cell(cells[i], "F4F5FA")
            para = cells[i].paragraphs[0]
            para.paragraph_format.space_before = Pt(3)
            para.paragraph_format.space_after = Pt(3)
            para.paragraph_format.line_spacing = 1.2
            fill_para(para, str(val), size=size, cn=HEAD_FONT_CN if i == 0 else BODY_FONT_CN)
    if widths:
        for row in t.rows:
            for i, w in enumerate(widths):
                row.cells[i].width = Cm(w)
    # 表格后留白
    sp = doc.add_paragraph()
    sp.paragraph_format.space_after = Pt(4)
    sp.paragraph_format.space_before = Pt(0)
    for r in sp.runs:
        pass
    return t


def FIG(fname, caption, width=16.0):
    path = os.path.join(SHOT, fname)
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.space_before = Pt(8)
    p.paragraph_format.space_after = Pt(2)
    p.paragraph_format.keep_with_next = True
    p.add_run().add_picture(path, width=Cm(width))
    c = doc.add_paragraph()
    c.alignment = WD_ALIGN_PARAGRAPH.CENTER
    c.paragraph_format.space_before = Pt(0)
    c.paragraph_format.space_after = Pt(12)
    r = c.add_run(caption)
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 8.5, False, GRAY)


# ---------- 页眉页脚 ----------
def add_page_number(paragraph):
    run = paragraph.add_run()
    fld = OxmlElement("w:fldSimple")
    fld.set(qn("w:instr"), "PAGE")
    r = OxmlElement("w:r")
    t = OxmlElement("w:t")
    t.text = "1"
    r.append(t)
    fld.append(r)
    run._element.addnext(fld)


footer_p = sec.footer.paragraphs[0]
footer_p.alignment = WD_ALIGN_PARAGRAPH.CENTER
fill_para(footer_p, "WFMC 新手操作手册　·　", size=8.5, color=GRAY)
add_page_number(footer_p)

header_p = sec.header.paragraphs[0]
header_p.alignment = WD_ALIGN_PARAGRAPH.RIGHT
hr = header_p.add_run("WFMC · 万帆 Minecraft 启动器")
_set_run_font(hr, HEAD_FONT_CN, HEAD_FONT_CN, 8.5, False, RGBColor(0x9A, 0x9E, 0xB2))

# ============ 封面 ============
cover = doc.add_paragraph()
cover.paragraph_format.space_before = Pt(60)
cover.paragraph_format.space_after = Pt(2)
r = cover.add_run("WFMC")
_set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 12, True, RGBColor(0x8C, 0x89, 0xD8))

t1 = doc.add_paragraph()
t1.paragraph_format.space_before = Pt(0)
t1.paragraph_format.space_after = Pt(6)
r = t1.add_run("新手操作手册")
_set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 34, True, ACCENT)

t2 = doc.add_paragraph()
t2.paragraph_format.space_after = Pt(24)
r = t2.add_run("从装游戏到进得去：每一步该点哪里，出问题该看哪句话")
_set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 13, False, RGBColor(0x45, 0x49, 0x60))

linep = doc.add_paragraph()
linep.paragraph_format.space_after = Pt(14)
_bottom_border(linep, ACCENT_HEX, "18")

meta = doc.add_paragraph()
meta.paragraph_format.space_after = Pt(2)
fill_para(meta, "适用版本：WFMC v1.0.44　　界面语言：简体中文（浅色主题）", size=9.5, color=GRAY)
meta2 = doc.add_paragraph()
meta2.paragraph_format.space_after = Pt(40)
fill_para(meta2, "整理依据：启动器实际界面截图 + 源码行为（下载、安装、崩溃诊断、联机）", size=9.5, color=GRAY)

TIP("为什么写这本手册", "启动器本身不难用，难的是「装不上」和「进不去」这两件事没人告诉你该看哪儿。"
                        "这本手册按真实操作顺序走一遍：先建好一个能跑的实例，再往里面加东西，最后教你在崩的时候怎么一眼找到原因。")

WARN("使用前须知", "手册里的按钮、标题、提示语都按 v1.0.44 的实际界面抄录；界面会随版本调整，文字对不上时就认功能、不认位置。"
                  "另外，本手册不承诺「照做一定能进游戏」—— 900 多个模组互相冲突属于上游作者的问题，手册能做的是让你每个现象都能追到一个原因。")

# ============ 目录 ============
doc.add_page_break()
tp = doc.add_paragraph()
tp.paragraph_format.space_before = Pt(0)
tp.paragraph_format.space_after = Pt(4)
r = tp.add_run("目　录")
_set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 19, True, ACCENT)
_bottom_border(tp)

TOC = [
    ("第 1 章", "先说结论：启动器帮你把哪一半做好了"),
    ("第 2 章", "界面速览：三分钟看懂你在哪一页"),
    ("第 3 章", "第一次启动：从下载游戏到点「启动」"),
    ("第 4 章", "装整合包：一键装成一个新实例（重点）"),
    ("第 5 章", "模组、光影、资源包：三件东西别放错抽屉"),
    ("第 6 章", "启动前自检：一张表，三十秒"),
    ("第 7 章", "进不去游戏：把崩溃报告当线索"),
    ("第 8 章", "联机：局域网、穿透、公网中继怎么选"),
    ("第 9 章", "服务器收藏、皮肤与外置登录"),
    ("第 10 章", "设置里值得改的几项"),
    ("附录 A", "数据都在哪个文件夹"),
    ("附录 B", "故障速查表"),
]
for num, title in TOC:
    p = doc.add_paragraph()
    pf = p.paragraph_format
    pf.space_before = Pt(5)
    pf.space_after = Pt(0)
    r = p.add_run(num + "　")
    _set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 11, True, ACCENT)
    r2 = p.add_run(title)
    _set_run_font(r2, HEAD_FONT_CN, HEAD_FONT_CN, 11, False, DARK)

P("")
TIP("三种读法", "①第一次装：按 2 → 3 → 4 的顺序走，一章不落。"
              "②已经装好、只是进不去：直接翻第 7 章的症状对照表。"
              "③想搞清楚某个按钮是干嘛的：翻到对应章节，索引在目录里。")

# ============ 第 1 章 ============
H1("第 1 章", "先说结论：启动器帮你把哪一半做好了")
P_lead("装模组这件事，「装不上」几乎全是版本、加载器、前置三件事之一；「进不去」几乎全是内存、Java、驱动、冲突四件事之一。"
       "这本手册后面所有章节，都是围绕这两句话展开的。")

P("WFMC 的思路不是把自己伪装成「一键盒子」，而是把关键参数摊开给你看：下载走国内镜像所以不慢，每个实例可以有自己的内存和 JVM 参数，"
  "整合包能一键装成新实例，崩溃报告会用中文告诉你「崩前发生了什么」，存档有自动备份。代价是：版本、加载器、依赖这三件事，得你自己确认对得上。")

H2("1.1 你负责什么，启动器负责什么")
TABLE(
    ["环节", "你负责", "启动器负责"],
    [
        ["版本", "想清楚要哪个 MC 版本、哪个加载器（Fabric / Forge / NeoForge）", "按你选的把游戏本体、libraries、assets 下齐，装不上时给出重试与换源"],
        ["整合包", "知道这个包是给哪个版本做的", "读清单，自动下对应版本的 MC 和加载器，装成独立实例"],
        ["模组", "决定装哪些、接受哪些不兼容", "列出依赖清单，必需前置一起装，加载器/版本不匹配的直接拦下来"],
        ["内存与 Java", "挑内存大小、确认 Java 大版本", "按 MC 版本自动挑 Java，本机没有时提供官方运行时下载"],
        ["出问题", "把「崩溃报告」里那句话说出来", "把日志翻译成中文，指出崩前最后一步和常见原因"],
        ["存档", "决定多久备份一次", "启动前自动备份，崩了能回滚"],
    ],
    widths=[2.4, 6.2, 7.6],
)

TIP("一句话记住", "**装不上 = 版本 / 加载器 / 前置**，三者之一对不上；**进不去 = 内存 / Java / 驱动 / 冲突**，四者之一不对。"
              "排查时先问自己：现在卡在哪一类？")

WARN("关于「一定能进」", "本手册保证的是「每个现象都能追到一个原因」，不保证「照做一定进得去」。"
                     "整合包里有九百多个模组，任意两个之间都可能打架，这类问题只能靠二分法缩小范围（见 7.2）。")

# ============ 第 2 章 ============
H1("第 2 章", "界面速览：三分钟看懂你在哪一页")
P_lead("左侧十个入口，用两次就记住了。右侧永远是「当前实例」的内容——这是这套界面最重要的一条规矩。")

TABLE(
    ["左侧入口", "干什么", "什么时候会用到"],
    [
        ["首页", "引导卡 + 最近在玩的实例", "第一次打开时；想快速回到上次的实例"],
        ["实例", "所有游戏版本与整合包的卡片，点开是设置", "建实例、改内存、删实例"],
        ["下载游戏", "按 MC 版本下载原版或加载器版本", "第一次装游戏；补齐某个版本"],
        ["模组·光影", "模组 / 光影 / 资源包 / 整合包 四个标签页", "加料的主力页面（第 4、5 章）"],
        ["服务器", "收藏服务器，看在线人数与延迟", "找服、连服"],
        ["联机", "把本机游戏分享给朋友（临时房间）", "和朋友一起玩（第 8 章）"],
        ["一键开服", "装一个常驻服务端（Paper / Vanilla）", "长期开服、装插件"],
        ["皮肤·外置登录", "LittleSkin 等皮肤站账号、换皮肤", "想用自己的皮肤（第 9 章）"],
        ["内容管理", "九个标签：模组 / 资源包 / 光影 / 存档 / 数据包 / 截图 / Mod 更新 / 崩溃报告 / 运行日志", "装完之后检查、崩了之后查原因"],
        ["设置", "外观、下载、性能、数据目录、Java、账号", "换源、调内存、搬数据目录（第 10 章）"],
    ],
    widths=[2.9, 8.0, 5.3],
)

H2("2.1 左下角那个「底座」")
P("左下角三件东西，决定了整个界面在替谁干活：")

BULLET("**当前实例**：显示的是「月亮工厂MCF 【Moon Create factory】」这样的名字。装模组、看崩溃报告、开存档，全都跟着它走。")
BULLET("**账号**：显示「Steve · 离线」这样的状态。离线号能玩单机，正版/外置登录才用得上联机和皮肤站。")
BULLET("**主题开关**：浅色 / 深色 / 跟随系统三选一，改了立刻生效，不用重启。")

WARN("最容易犯的错", "不看「安装到哪个实例」就点安装 —— 模组装进了 A 实例，你却启动 B 实例，然后说「模组没生效」。"
                  "装之前先抬头看一眼页面顶部那行「安装到：……」。")

FIG("guide-01-home.png", "图 2-1　首页：左侧导航 + 右侧引导。第一次打开先选账号，再下游戏")

# ============ 第 3 章 ============
H1("第 3 章", "第一次启动：从下载游戏到点「启动」")
P_lead("目标只有一个：先让一个「什么模组都没装」的干净实例跑起来。这一步看起来多余，实际上是后面所有排错的地基。")

H2("3.1 下载游戏")
P("进入左侧「下载游戏」，选 MC 版本，再选加载器（原版 / Fabric / Forge / NeoForge），点下载。下载走国内镜像，"
  "如果某个文件卡住不动，去设置里的「下载与网络」换源或换线程数。")
FIG("guide-02-download.png", "图 3-2　下载游戏：选版本 → 选加载器 → 下载，进度和失败重试都在这一页")

H2("3.2 实例：一张卡片就是一个游戏")
P("每个版本或整合包都是一个实例卡片。卡片上标着版本与加载器，比如「1.20.1 · fabric」——这个后缀就是你核对版本的第一现场。"
  "点开卡片是实例设置，有三组东西值得看一眼：")

BULLET("**最大内存 / 最小内存**：默认 4096 / 1024 MB。整合包越重，最大内存越要给足。")
BULLET("**额外 JVM 参数**：不懂就别填；想优化可以用「性能预设」一键套 JVM 参数与 `options.txt`。")
BULLET("**游戏目录**：每个实例的 `mods`、`resourcepacks`、`shaderpacks`、`saves`、`config`、`logs`、`crash-reports` 都是分开的；"
       "`libraries` 和 `assets` 跨实例共享，所以装第二个整合包不会翻倍占硬盘。")

FIG("guide-03-instances.png", "图 3-1　实例页：每张卡片就是一个可启动的游戏，右上角是新建入口")
FIG("guide-04-instance-settings.png", "图 3-3　实例设置：内存、JVM 参数、性能预设都在这")

H2("3.3 先别急着装东西")
OKBOX("地基原则", "先在零模组状态下进一次主界面。能进，说明 Java、内存、显卡这一层没问题，后面出问题只可能是模组的事；"
              "进不去，说明是环境问题，跟模组无关 —— 这两类问题的排查方向完全相反。")

# ============ 第 4 章 ============
H1("第 4 章", "装整合包：一键装成一个新实例（重点）")
P_lead("整合包不是「把一堆 jar 复制进去」，而是一场按清单对账的安装：清单说要 1.20.1 + Fabric + 这些模组的这几个版本，启动器照着清单去下、去拼。")

H2("4.1 整合包里到底有什么")
P("一个 `.mrpack` 或整合包 zip，里面是 `mods/`、`config/`，有时还有 `resourcepacks/` 和 `shaderpacks/`，外加一份清单："
  "「我要 MC 1.20.1、要 Fabric、要这九百多个模组的这几个版本」。所以你手动解压再一个个装，几乎一定会漏版本。")

H2("4.2 两种来源")
TABLE(
    ["来源", "怎么用", "适合谁"],
    [
        ["在线（Modrinth 镜像）", "「模组·光影 → 整合包」搜索关键词，点「安装最新版」", "想装主流整合包，最省事，免 API Key"],
        ["本地导入", "点「导入本地 .mrpack / .zip」，选文件", "别人发给你的包，或自己导出的包（CurseForge 压缩包也认）"],
    ],
    widths=[3.6, 7.0, 5.6],
)
P("在线装的最大好处是会自动下对应版本的 MC 和加载器，装完就是一个能直接点「启动」的实例；本地导入同样会自动补齐，不用你自己对齐版本。")

H2("4.3 在线一键装：六步")
NUM(1, "左侧「模组·光影」，顶部切到「整合包」标签页。")
NUM(2, "搜索框输关键词（例如：机械动力、空岛、RLCraft），或点「导入本地 .mrpack / .zip」。")
NUM(3, "MC 版本与加载器保持默认 —— 默认按整合包清单自动匹配，别手动乱改。")
NUM(4, "点卡片上的「安装最新版」；想装旧版本就点「选版本」。")
NUM(5, "等下载与安装跑完，左侧「实例」里会多出一张新卡片。")
NUM(6, "第一次启动前，进实例设置把最大内存调到 4096 MB 以上。")

OKBOX("装成功的三个标志", "① 实例卡片上标着类似「1.20.1 · fabric」；② 「内容管理 → 模组」里的 jar 数量和整合包清单对得上；"
                     "③ 启动日志里写的是「加载了 N 个模组」，而不是一句 `NoClassDefFoundError`。三条都对，说明装成了。")
FIG("guide-06-modpacks.png", "图 4-1　整合包页：搜索框、MC 版本/加载器、本地导入入口都在这一屏")

H2("4.4 木桶整合包：一次装对的顺序")
P("本仓库里的「木桶整合包」是 **1.20.1 + Fabric** 的组合。装之前先确认你手里是哪种素材，三条路走法完全不同：")
TABLE(
    ["你手上有什么", "怎么装", "注意"],
    [
        ["一个 .mrpack 或整合包 zip", "「整合包」页 → 导入本地 → 选文件", "装完会新建实例，别在旧实例里再点一次"],
        ["一堆 mod 的 jar 文件", "先建 1.20.1 + Fabric 空实例，再逐个/批量装（第 5 章）", "最容易漏前置，装的时候看依赖清单"],
        ["整合包 + 汉化包 zip + 光影 zip", "先装整合包，再按 5.4 加汉化、5.5 加光影", "顺序不能反：先有实例，再往里加料"],
    ],
    widths=[4.6, 7.0, 4.6],
)
P("具体到手的时候，记住这六条：")
BULLET("**版本必须是 1.20.1 + Fabric**。这两项不一致，后面所有努力都白费；实例卡片上的后缀就是核对点。")
BULLET("**汉化包是资源包，不是模组**。它进 `resourcepacks/`，不进 `mods/` —— 放错抽屉等于没装。")
BULLET("**光影要 Iris，不要 OptiFine**。两个同时装，轻则掉帧，重则直接进不去。")
BULLET("**内存 4096 MB 是下限**。九百多个模组建议 6144–8192 MB，但别超过物理内存的 60%，否则系统本身会开始换页，反而更卡。")
BULLET("**第一次进游戏前，打开「启动前自动备份存档」**（设置 → 界面与行为）。崩一次能回滚，比什么都省事。")
BULLET("**进不去先看崩溃报告**，别急着重装 —— 重装解决不了版本不对，只会浪费四十分钟。")

H2("4.5 装完的三件小事")
BULLET("把实例名改清楚。两个版本并存时，「月亮工厂MCF」这种名字比「New Instance 2」靠谱得多。")
BULLET("进一次主界面（不是存档），确认能到标题画面。这一步排除掉 80% 的环境问题。")
BULLET("记下「内容管理 → 模组」里的模组数量。以后模组「莫名消失」，第一件事就是拿这个数字对账。")

# ============ 第 5 章 ============
H1("第 5 章", "模组、光影、资源包：三件东西别放错抽屉")
P_lead("三个抽屉，放错就白费：mods 是模组，resourcepacks 是资源包（含汉化），shaderpacks 是光影。")
FIG("guide-05-modswap.png", "图 5-1　模组页：左侧选实例，中间搜模组，卡片上三个按钮管安装")

H2("5.1 装模组的三个前提")
TABLE(
    ["前提", "对不上会怎样", "在哪儿核对"],
    [
        ["MC 版本一致", "模组不会报错，就是不生效；或者启动即崩", "页面顶部「MC 版本」下拉 + 卡片上的版本标签"],
        ["加载器一致", "Fabric 的模组装进 Forge 实例：直接不启动", "页面顶部「加载器」下拉；实例卡片后缀"],
        ["前置依赖齐全", "缺什么它就崩给你看，报告里写着缺谁", "安装时弹出的依赖清单"],
    ],
    widths=[3.4, 7.4, 5.4],
)

H2("5.2 卡片上三个按钮的意思")
TABLE(
    ["按钮", "作用"],
    [
        ["安装最新版", "按当前筛选（实例 / MC 版本 / 加载器）装该模组的最新兼容版本，前置一起装"],
        ["选版本", "手动挑一个历史版本，适合「新版本反而不能用」的情况"],
        ["页面", "打开它在 Modrinth 上的主页，看更新日志与作者说明"],
    ],
    widths=[3.4, 12.8],
)
P("页面下方那行小字是这套安装器的核心承诺，值得原样抄下来：**「点安装会先列出依赖清单：必需前置一起装、可选前置你勾、冲突项只提示。加载器和 MC 版本对不上的直接拦下来。」**"
  "最后半句是重点 —— 它在装之前就拦你，比装完崩溃再排查便宜得多。")

H2("5.3 依赖清单弹窗怎么读")
BULLET("**必需（required）**：不装就崩，默认勾上，别取消。")
BULLET("**可选（optional）**：装不装都能跑，通常是功能增强，按需勾。")
BULLET("**冲突**：两个模组改同一处，只能留一个，启动器只提示不替你选。")

H2("5.4 汉化包：923 个模组的中文在哪")
P("「内容管理 → 模组」底部会写明已装汉化包的覆盖情况：一共打包了多少个模组的中文、其中多少个模组确实有中文。"
  "界面上还有一句很实在的话：**「模组里直接写死的文字，比如标题栏那种，资源包也翻不了，那是作者代码里的字符串。」**"
  "所以「装了汉化还有英文」是正常现象，不是装错了。")
BULLET("汉化包按资源包加载，进 `resourcepacks/`；卸载时启动器会自动清掉 `options.txt` 里的引用，不留悬空条目。")
BULLET("汉化包和 MC 版本要对得上：1.20.1 的汉化别丢进 1.21 的实例。")
FIG("guide-07-manage.png", "图 5-2　内容管理·模组：已装模组清单与汉化包覆盖说明都在这一页（顶部一排是九个标签页）")

H2("5.5 光影：Iris + Sodium 是正解")
P("1.20.1 上的标准组合是 Iris（光影加载）+ Sodium（渲染优化）。光影掉帧，先看显卡与显存，再换一套更轻的光影，最后才动模组。"
  "OptiFine 与 Iris 二选一，不要共存。")

H2("5.6 装错版本了怎么办")
P("页面顶部有两个下拉：「安装到哪个实例」和「MC 版本 / 加载器」。改完再点安装即可；对不上会被拦下来，不会半装。"
  "如果只是想换个版本试试，用「选版本」比重新下载整包快得多。")

# ============ 第 6 章 ============
H1("第 6 章", "启动前自检：一张表，三十秒")
P_lead("点「启动」之前花三十秒过一遍这张表，能省掉之后半小时的排查。")

TABLE(
    ["检查项", "正确状态", "不对会怎样"],
    [
        ["MC 版本", "实例卡片上的版本 = 整合包要求的版本", "启动即崩，或模组静默失效"],
        ["加载器", "Fabric / Forge / NeoForge 与模组一致", "报「找不到主类」"],
        ["最大内存", "≥ 4096 MB；九百模组建议 6144–8192 MB", "进世界时 `OutOfMemoryError`"],
        ["Java 版本", "1.20.5+ 用 Java 21；1.18–1.20.4 用 Java 17；1.17 用 16；更老用 8", "`UnsupportedClassVersionError`"],
        ["前置依赖", "依赖清单里的「必需」全部装齐", "报告里明确写着「Mod X requires Y」"],
        ["光影", "Iris 与 OptiFine 不同时存在", "黑屏、掉帧、进不去"],
        ["汉化包", "版本与实例一致，且放在 resourcepacks", "资源包加载失败，或干脆没效果"],
        ["存档备份", "「启动前自动备份存档」已打开", "崩了只能重来"],
    ],
    widths=[2.8, 8.0, 5.4],
)

TIP("排查法第一条", "先用最小配置进一次：关掉所有光影、只留必需前置。能进 → 底子是好的，问题在某个模组，用二分法找；"
                "进不去 → 是环境问题（Java / 内存 / 驱动），跟模组无关。")

# ============ 第 7 章 ============
H1("第 7 章", "进不去游戏：把崩溃报告当线索")
P_lead("崩溃报告不是判决书，是线索。它通常第一行就告诉了你「谁不满意」，剩下的只是翻译。")

H2("7.1 在哪儿看")
P("左侧「内容管理」→ 顶部「崩溃报告」标签页。页面上有三个东西：「刷新」「一键诊断崩前原因」「N 个崩溃报告」。"
  "诊断会把崩前最后一段日志和常见原因翻成中文，是最快的入口。没有任何报告时，它会显示「没有崩溃报告，挺稳」。")
FIG("guide-09-crash.png", "图 7-1　崩溃报告：一键诊断 + 份数统计；没有崩溃时会明确告诉你「没有」")

H2("7.2 症状对照表")
TABLE(
    ["现象", "报告里常见字样", "真正原因", "怎么办"],
    [
        ["闪一下就没了", "`NoClassDefFoundError: net/minecraft/client/main/Main`", "加载器或版本不匹配（Fabric mod 装进 Forge 实例）", "换对应版本/加载器重装该模组"],
        ["启动到一半退出", "`UnsupportedClassVersionError`", "Java 大版本不对", "按 6 章对照表换 Java，或在设置里下载官方运行时"],
        ["明确点名缺东西", "`Mod X requires Y`", "前置没装或版本不对", "按依赖清单补齐必需前置"],
        ["进世界时崩", "`OutOfMemoryError: Java heap space`", "内存给小了", "最大内存调到 6144–8192，别超物理内存 60%"],
        ["黑屏 / 花屏", "`GLFW error 65542`、OpenGL 相关", "显卡驱动老旧，或核显不支持", "更新显卡驱动；先关光影再试"],
        ["报 Mixin 失败", "`Mixin apply failed`，后面跟着某个 mod 名", "两个模组改同一处代码", "二分法：一半一半禁用，锁定冲突的两个"],
        ["只在某个存档崩", "`Ticking entity` / `Ticking block entity`", "存档里的实体/方块出问题", "从自动备份回滚到崩前"],
        ["资源包相关报错", "汉化包或资源包版本不符", "汉化包与 MC 版本不一致", "换同版本汉化；或先卸汉化验证"],
        ["报告是空的", "——", "根本没跑到 JVM", "看「运行日志」，多半是 Java 路径没找到"],
    ],
    widths=[2.6, 4.6, 4.6, 4.4],
    size=9,
)

H2("7.3 为什么「别人能进，我不能」")
P("同一份整合包，能不能进取决于四件本地的事：**Java 版本、内存大小、显卡驱动、路径与权限**。所以「网上有人说能进」不构成证据，"
  "「我上次能进」也不构成证据 —— 只要显卡驱动更新过一次，结论就可能翻过来。")

H2("7.4 日志怎么看")
P("「内容管理 → 运行日志」看时间线；`crash-reports` 文件夹里有原始文件。找人求助时，贴崩溃报告比说「它崩了」有用一百倍 —— "
  "因为报告里有那一句「谁不满意」。")

# ============ 第 8 章 ============
H1("第 8 章", "联机：局域网、穿透、公网中继怎么选")
P_lead("先把两件事分清楚：你要的是「今晚和朋友玩一会儿」，还是「一个一直在线的服务器」。这两件事在启动器里是两个页面。")

FIG("guide-11-online.png", "图 8-1　联机页：上半屏用一张对比卡把「临时房间」和「常驻服务端」讲清楚")

H2("8.1 两种情况，两个页面")
TABLE(
    ["", "「联机」页：开房间（临时）", "「一键开服」页：开服务端（常驻）"],
    [
        ["谁在跑", "你自己的客户端 + 游戏里的「对局域网开放」", "启动器另起一个独立服务端进程"],
        ["关掉窗口", "退出游戏，房间就没了", "窗口关了也不退出，缩到托盘继续跑"],
        ["人数", "受游戏内限制，一般 8 人左右", "可调，装插件/mod（Fabric / Forge / NeoForge）"],
        ["适合", "临时和朋友玩一晚上、玩自己的存档", "长期开服、朋友随时来、带模组的整合服"],
    ],
    widths=[2.4, 6.9, 6.9],
)

H2("8.2 局域网直连（同一路由器下）")
P("点「开始发现局域网世界」。朋友或你自己在游戏里对局域网开放之后，这里会自动出现房间；右边会显示房主的版本、加载器、模组数"
  "（前提是房主也用 WFMC），点「进入」就能直连。零配置，但只能同网。")

H2("8.3 P2P 打洞（UPnP）")
P("「把 25565 端口映射到公网」＝ 在路由器上加一条端口映射，外网就能用「公网IP:端口」连进来，流量不过第三方，延迟最低。"
  "需要路由器开着 UPnP；打不通就用「查我的公网地址」先确认外网 IP。")

H2("8.4 公网中继")
P("路由器不给映射时，只能走中继：能连上，但延迟取决于中继服务器。这是「实在打不通」时的保底方案，不是首选。")

H2("8.5 端口与防火墙")
BULLET("要共享的游戏端口默认 `25565`；在游戏里点过「对局域网开放」之后，这里会自动变成游戏实际用的那个端口，不用手填。")
BULLET("页面上会显示本机内网地址（例如 `192.168.1.76`）；同网的朋友直接连这个地址。")
BULLET("第一次共享时 Windows 防火墙会弹窗，要允许「专用网络」。拒绝了就会一直连不上，而且没有任何报错。")

H2("8.6 三种渠道对照")
TABLE(
    ["渠道", "配置成本", "延迟", "能用范围"],
    [
        ["局域网直连", "零配置", "最低", "同一路由器下"],
        ["P2P 打洞（UPnP）", "需要在路由器开 UPnP", "低", "外网可连，需路由器支持"],
        ["公网中继", "零配置", "取决于中继", "都能连，但慢一些"],
    ],
    widths=[4.0, 5.0, 3.2, 4.0],
)
FIG("guide-14-hosting.png", "图 8-2　一键开服：服务端类型、游戏版本、名称、内存、端口，一次填完点「创建并下载」")

# ============ 第 9 章 ============
H1("第 9 章", "服务器收藏、皮肤与外置登录")

H2("9.1 服务器：把常去的服存下来")
P("「服务器」页支持收藏服务器、查在线人数与延迟、解析 SRV 记录，并一键带着 IP 进服。地址栏支持 `mc.hypixel.net` 这种域名，"
  "也支持 `play.example.com:25566` 这种带端口的写法。")
FIG("guide-12-server.png", "图 9-1　服务器页：填地址 → 收藏 / 只查询；没有收藏时会明确提示")

H2("9.2 外置登录：用自己的皮肤站账号")
P("「皮肤·外置登录」支持 authlib-injector 协议（LittleSkin、Blessing Skin 等）。登录后能管角色、换皮肤和披风，启动游戏时会自动注入验证。")
BULLET("验证服务器默认填 `https://littleskin.cn/api/yggdrasil`，换成你自己的皮肤站地址也行。")
BULLET("懒得复制地址？把皮肤站那张「Yggdrasil 外置登录」卡片直接拖进这个窗口，会自动跳到本页并填好地址；拖不动就复制卡片链接再点「从剪贴板识别」。")
BULLET("登录成功后，「当前角色」卡片会出现你的角色与皮肤预览。")
FIG("guide-13-skin.png", "图 9-2　皮肤·外置登录：地址、账号、密码 + 三个辅助按钮")

H2("9.3 微软正版登录")
P("设置 → 账号里可以「微软正版登录」。正版账号用得上联机、皮肤站和一部分服务器的白名单；离线账号只适合单机与自建服务器。")

# ============ 第 10 章 ============
H1("第 10 章", "设置里值得改的几项")
P_lead("设置页左边是竖排图标导航，十个分区。绝大多数人只需要改三处：下载源、内存、数据目录。")
FIG("guide-08-settings.png", "图 10-1　设置·外观与主题：主题三选一、主色板、圆角、界面语言都在这一屏")

TABLE(
    ["分区", "主要能改什么"],
    [
        ["外观", "浅色 / 深色 / 跟随系统；主色板、圆角、背景图；界面语言（中文 / English）"],
        ["下载与网络", "下载源（国内镜像 BMCLAPI / Mojang 官方 / 自动测速）、下载线程数、限速"],
        ["内存与性能", "默认内存与性能预设（一键套 JVM 参数 + options.txt）"],
        ["数据目录", "看占用明细、清理缓存/下载/日志、把整个数据目录搬到别的盘"],
        ["Java 运行时", "已检测到的 Java、重新扫描、手动指定 java.exe、下载 Java 21 / 17 / 8"],
        ["账号", "离线账号、微软正版登录、外置登录（authlib-injector）"],
        ["CurseForge", "CurseForge API Key（Modrinth 不需要）"],
        ["更新 / 致谢 / 关于", "检查启动器更新、开源致谢、版本信息"],
    ],
    widths=[3.4, 12.8],
)

H2("10.1 三个真正值得改的地方")
BULLET("**关闭窗口时**：选「缩到托盘（服务端继续跑）」而不是「直接退出程序」。这样一键开服的服务端不会被你顺手关掉。")
BULLET("**启动前自动备份存档**：「开着（崩了能回滚）」。存档崩坏是唯一不可逆的损失。")
BULLET("**数据目录**：默认在 `F:\\wfmc-data` 这类位置，可以在设置里搬家。C 盘红了就先搬这个。")

H2("10.2 Java 运行时")
P("界面上写得很清楚：**「1.20.5+ 要 Java 21，1.18–1.20.4 要 Java 17，1.17 要 16，更老的版本用 Java 8。留空时启动器会按版本自动挑。」**"
  "所以正常情况下你什么都不用做；只有在「自动挑错了」或者「本机没有对应版本」时，才需要来这里手动指定或下载。")
FIG("guide-10-java.png", "图 10-2　Java 运行时与账号：自动选择、重新扫描、手动指定，以及三个官方运行时下载入口")

# ============ 附录 A ============
H1("附录 A", "数据都在哪个文件夹")
P("设置页顶部会显示当前数据目录（例如 `F:\\wfmc-data`），旁边的「打开数据目录」直接跳过去。里面大致是这些：")
TABLE(
    ["位置", "装的是什么", "想动它的时候"],
    [
        ["`instances/`", "每个实例一套游戏目录（mods / resourcepacks / shaderpacks / saves / config / logs / crash-reports）", "手动放 jar、翻日志、备份存档"],
        ["`java/`", "启动器下载的 Java 运行时", "别手动删，删了对应版本会启动失败"],
        ["`backups/`", "启动前自动备份的存档", "崩存档后从这里回滚"],
        ["`servers/`", "一键开服建的服务端", "改服务端配置、装插件"],
        ["`downloads/`", "下载缓存", "磁盘紧张时可以清（设置 → 数据目录里有入口）"],
        ["`settings.json`", "启动器的全部设置", "出怪问题时可以备份一份再动"],
    ],
    widths=[3.2, 9.0, 4.0],
)
TIP("共享的部分", "`libraries` 与 `assets` 是跨实例共享的，所以装第二个、第三个整合包不会线性占硬盘。真正吃空间的是每个实例的 `mods` 和 `saves`。")

# ============ 附录 B ============
H1("附录 B", "故障速查表")
TABLE(
    ["你看到的现象", "先看这一条"],
    [
        ["点启动没反应 / 窗口一闪而过", "第 7.2 节第一行「找不到主类」；再确认 Java 是否被识别"],
        ["卡在加载界面 / 进度条不动", "内存是否太小；看「运行日志」最后一行停在哪个资源"],
        ["模组装了但游戏里没变化", "装错实例了（看页面顶部「安装到：」）；或加载器不匹配"],
        ["报「缺少前置」", "安装时依赖清单里勾了「必需」吗"],
        ["进世界就崩，单人新世界正常", "存档问题：从 `backups/` 回滚"],
        ["联机对方连不上", "防火墙是否允许；是否用了对的端口和内网地址"],
        ["光影开了就花屏", "先关光影确认是光影问题，再更新显卡驱动"],
        ["汉化不生效", "汉化包放进了 `resourcepacks` 吗；版本和实例一致吗"],
        ["磁盘突然少了几十 GB", "`instances` 下每个实例的 mods/saves；以及 `downloads/` 缓存"],
        ["想知道到底崩在哪", "「内容管理 → 崩溃报告 → 一键诊断崩前原因」"],
    ],
    widths=[6.2, 10.0],
)

end = doc.add_paragraph()
end.paragraph_format.space_before = Pt(18)
end.alignment = WD_ALIGN_PARAGRAPH.CENTER
r = end.add_run("—— 手册完 ——")
_set_run_font(r, HEAD_FONT_CN, HEAD_FONT_CN, 10, False, GRAY)

os.makedirs(os.path.dirname(OUT), exist_ok=True)
doc.save(OUT)
print("saved:", OUT)
print("paragraphs:", len(doc.paragraphs), "tables:", len(doc.tables))

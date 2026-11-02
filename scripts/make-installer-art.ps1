# 生成 NSIS 安装界面的两张位图（installerHeader.bmp / installerSidebar.bmp）
# 以前这两张是手绘的「白圆底 + 大写 WF 字母」，和 exe 图标（紫色圆角方块 + WF 变形标）不一致，
# 用户反馈「安装界面那个图标中间怎么是字母的 WF」。这里直接用 build\icon.png 合成，跟托盘/exe 同一个标。
#
# 用法：pwsh -File scripts\make-installer-art.ps1
# 产物：build\installerHeader.bmp (150x57 24bpp)、build\installerSidebar.bmp (164x314 24bpp)
# 注意：NSIS 只认 24bpp/32bpp BMP；向导页背景是白色，所以两张图都用浅色渐变底，别做透明通道。

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent $PSScriptRoot
$iconPath = Join-Path $root 'build\icon.png'
if (-not (Test-Path $iconPath)) { throw "找不到 $iconPath" }

$src = [System.Drawing.Image]::FromFile($iconPath)

function New-Canvas([int]$w, [int]$h, [string]$out) {
  $bmp = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
  $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
  $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
  $g.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::ClearTypeGridFit
  # 浅紫→白 竖向渐变，贴近安装向导的白底
  $rect = New-Object System.Drawing.Rectangle(0, 0, $w, $h)
  $brush = New-Object System.Drawing.Drawing2D.LinearGradientBrush($rect,
    [System.Drawing.Color]::FromArgb(255, 255, 255), [System.Drawing.Color]::FromArgb(255, 243, 240, 255), 90.0)
  $g.FillRectangle($brush, $rect)
  $brush.Dispose()
  return @{ bmp = $bmp; g = $g; out = $out }
}

function Save-Canvas($c) {
  $c.g.Dispose()
  $c.bmp.Save($c.out, [System.Drawing.Imaging.ImageFormat]::Bmp)
  $c.bmp.Dispose()
  "wrote $($c.out)"
}

# ---- 右上角小横条 150x57：左边 logo，右边两行字 ----
$h = New-Canvas 150 57 (Join-Path $root 'build\installerHeader.bmp')
$hs = New-Object System.Drawing.Rectangle(6, 8, 41, 41)
$h.g.DrawImage($src, $hs)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 31, 36, 48))
$grey = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 110, 118, 135))
$fTitle = New-Object System.Drawing.Font('Segoe UI', 13, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fSub = New-Object System.Drawing.Font('Microsoft YaHei', 11, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$h.g.DrawString('WFMC', $fTitle, $dark, 54, 12)
$h.g.DrawString('万凡科技', $fSub, $grey, 55, 31)
$fTitle.Dispose(); $fSub.Dispose(); $dark.Dispose(); $grey.Dispose()
Save-Canvas $h

# ---- 左侧竖条 164x314：中间 logo + 名称 ----
$s = New-Canvas 164 314 (Join-Path $root 'build\installerSidebar.bmp')
$ss = New-Object System.Drawing.Rectangle(42, 92, 80, 80)
$s.g.DrawImage($src, $ss)
$dark = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 31, 36, 48))
$grey = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 110, 118, 135))
$fBig = New-Object System.Drawing.Font('Segoe UI', 20, [System.Drawing.FontStyle]::Bold, [System.Drawing.GraphicsUnit]::Pixel)
$fMid = New-Object System.Drawing.Font('Microsoft YaHei', 13, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$fSmall = New-Object System.Drawing.Font('Microsoft YaHei', 10, [System.Drawing.FontStyle]::Regular, [System.Drawing.GraphicsUnit]::Pixel)
$center = New-Object System.Drawing.StringFormat
$center.Alignment = [System.Drawing.StringAlignment]::Center
$s.g.DrawString('WFMC', $fBig, $dark, (New-Object System.Drawing.RectangleF(0, 182, 164, 30)), $center)
$s.g.DrawString('万凡科技', $fMid, $grey, (New-Object System.Drawing.RectangleF(0, 214, 164, 22)), $center)
$s.g.DrawString('Minecraft 启动器', $fSmall, $grey, (New-Object System.Drawing.RectangleF(0, 240, 164, 18)), $center)
$center.Dispose(); $fBig.Dispose(); $fMid.Dispose(); $fSmall.Dispose(); $dark.Dispose(); $grey.Dispose()
Save-Canvas $s

$src.Dispose()

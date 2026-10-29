@echo off
chcp 65001 >nul
setlocal enabledelayedexpansion
cd /d "%~dp0"

echo ============================================
echo   WFMC 发布到 GitHub Releases
echo ============================================
echo.
echo 先确认 release 目录里有 exe（WFMC-Portable-*.exe / WFMC-Setup-*.exe）
if not exist "release\*.exe" (
  echo [错误] release 目录里没有 exe，先运行 npm run dist
  pause
  exit /b 1
)
dir /b release\*.exe
echo.

if "%GH_TOKEN%"=="" (
  echo 去这里生成一个 classic token，勾选 repo 权限：
  echo   https://github.com/settings/tokens/new?scopes=repo^&description=WFMC-publish
  echo.
  set /p GH_TOKEN=粘贴 token（ghp_ 开头，粘贴后回车）:
)

if "%GH_TOKEN%"=="" (
  echo [错误] 没有 token
  pause
  exit /b 1
)

if "%GH_OWNER%"=="" set /p GH_OWNER=你的 GitHub 用户名:
if "%GH_REPO%"=="" set GH_REPO=wfmc
if "%GH_TAG%"=="" set GH_TAG=v1.0.0

echo.
echo 即将发布到 %GH_OWNER%/%GH_REPO%  tag=%GH_TAG%
echo.
node scripts\publish-github.mjs --owner "%GH_OWNER%" --repo "%GH_REPO%" --tag "%GH_TAG%" --notes CHANGELOG.md
echo.
echo 发布结束后，把「更新源」填成：%GH_OWNER%/%GH_REPO%
echo （软件里：设置 - 检查更新 - 更新源）
echo.
pause

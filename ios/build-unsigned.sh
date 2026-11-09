#!/usr/bin/env bash
# 在 macOS 上一键产出未签名 ipa（需要 Xcode + XcodeGen）
# 用法：brew install xcodegen && ./build-unsigned.sh
set -euo pipefail
cd "$(dirname "$0")"

command -v xcodegen >/dev/null 2>&1 || {
  echo "缺少 XcodeGen，请先执行：brew install xcodegen"
  exit 1
}

echo "==> 生成 Xcode 工程"
xcodegen generate

echo "==> 编译（不签名）"
xcodebuild \
  -project MiniBuddy.xcodeproj \
  -scheme MiniBuddy \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath build \
  CODE_SIGNING_ALLOWED=NO \
  CODE_SIGNING_REQUIRED=NO \
  CODE_SIGN_IDENTITY="" \
  PROVISIONING_PROFILE_SPECIFIER="" \
  clean build

APP="build/Build/Products/Release-iphoneos/MiniBuddy.app"
test -d "$APP" || { echo "找不到 MiniBuddy.app，编译失败"; exit 1; }

echo "==> 打包 ipa"
rm -rf Payload MiniBuddy-unsigned.ipa
mkdir Payload
cp -R "$APP" Payload/
zip -qry MiniBuddy-unsigned.ipa Payload

echo "完成：$(pwd)/MiniBuddy-unsigned.ipa"
echo "接下来用 Sideloadly / AltStore / 爱思助手 选择这个 ipa，填自己的 Apple ID 自签安装。"

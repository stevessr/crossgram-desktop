# Crossgram 自动更新（桌面端）

tdesktop 自带完整的更新链路：检查 `<prefix>/current<N>` → 下载 → 校验（SHA-1 + RSA）
→ 解包到 `tupdates/temp` → 由 `Updater` 在退出时替换文件并重启。Crossgram 的构建一直
用 `-DDESKTOP_APP_DISABLE_AUTOUPDATE=ON` 把整套逻辑编译掉，「检查更新」只会打开上游的
频道/网页，所以 PC 端根本没有更新能力。

这个 feature 打开并接管它：

1. `core/version.h` 的 `AppVersion` 换成 `100000000 + <workflow run>`：既大于任何上游
   版本号（客户端只在 `availableVersion > AppVersion` 时才更新），又能让已经更新过的
   客户端认出「这就是我这一版」，不会反复提示；
2. `config.h` 的 `UpdatesPublicKey`/`UpdatesPublicBetaKey` 换成 Crossgram 的更新公钥
   （私钥只存在于 CI secret `CROSSGRAM_UPDATE_KEY`，由工作流写成 packer 需要的
   `packer_private.h`/`alpha_private.h`，不会进仓库）；
3. `_other/packer.cpp` 里的自检公钥同步替换，并把上游只在 `DESKTOP_APP_SPECIAL_TARGET`
   下才会生成的 `Packer` 目标改为在 `-DCROSSGRAM_BUILD_UPDATE_PACKER=ON` 时也生成；
4. `storage/localstorage.cpp` 的 `readAutoupdatePrefixRaw()` 换成按「target + brand +
   platform」指向 Crossgram 的更新源，忽略 `tdata/prefix`，防止旧前缀把更新指向别处。

更新源是仓库的 `updates` 分支（raw.githubusercontent.com 只提供小体积的 feed 文本）：

    <FEED_BASE>/<target>-<brand>/<platform>/current<N>
    内容：<version>:<更新包 release 资产 URL>

`<N>` 取 `Platform::AutoUpdateVersion()`（Windows/Linux 现代版是 6，老 glibc 是 2，macOS
是 3），所以发布时同时写 `current`/`current2`/`current3`/`current6`。响应用的是更新器
最先尝试的旧文本格式（`version:url`），URL 会原样使用，于是更新包可以继续放在 GitHub
Release 上，不必让 feed 主机扛大文件。

## 发布侧

Windows/Linux 构建在同一个 run 里用上游自己的 `Packer` 生成签名更新包：

    Packer -path <staging dir> -version 100000<run> -target win64

产物 `crossgram-<target>-<brand>-<platform>-<version>.upd` 随 Release 一起发布；publish
阶段会校验签名（SHA-1 + `openssl dgst -verify`）、生成 feed 文本并推送到 `updates` 分支。

## 签名密钥要求

上游 Packer 的自动更新格式固定使用 128 字节 RSA/SHA-1 签名，私钥必须是
**RSA-1024**，并与 `assets/update-public-key.pem` 中的公钥匹配。发布时工作流及
patcher 在编译前拒绝 2048 位或不匹配的私钥。不能仅重新生成私钥而保留旧公钥。

Linux 手动 build-only 始终生成临时 RSA-1024 私钥和对应公钥，并同时注入
Packer 和客户端。这类构建用于下载测试，不兼容生产更新源的签名，不上传私钥。

## 说明

- 只有 `--platform` 与 `--build` 同时给出时才会改动版本号/更新源；本地或 check 工作流
  不带参数跑 `yarn apply` 时更新逻辑保持原样（packer 目标与公钥仍会就位）。
- 更新包的名单与上游一致：`<Exe>.exe` 与 `Updater.exe`（不含其它文件），
  解包后由 `Updater` 覆盖安装目录。

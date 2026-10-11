import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchServerSwitch } from "../features/server-switch/patch.js";
import { targetById } from "../src/targets.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "crossgram-desktop-server-switch-"));
  temporaryDirectories.push(root);
  const files: Record<string, string> = {
    "Telegram/CMakeLists.txt": `init_non_host_target(Telegram)
target_sources(Telegram PRIVATE
    countries/countries_manager.h
)
`,
    "Telegram/build/prepare/prepare.py": `    msbuild -m dump_syms.vcxproj /property:Configuration=Release /property:Platform="x64"
qtbase qtimageformats qtsvg
qtbase qtimageformats qtshadertools qtsvg
`,
    "Telegram/SourceFiles/mtproto/mtproto_dc_options.h": `class DcOptions {
public:
\t[[nodiscard]] bool isTestMode() const;
private:
\tbool _immutable = false;
};
`,
    "Telegram/SourceFiles/mtproto/mtproto_dc_options.cpp": `DcOptions::DcOptions(const DcOptions &other)
: _data(other._data)
, _immutable(other._immutable) {
}

bool DcOptions::isTestMode() const {
\treturn false;
}
`,
    "Telegram/SourceFiles/mtproto/config_loader.cpp": `void ConfigLoader::load() {
\tif (_proxyEnabled || _instance->isKeysDestroyer()) {
\t\treturn;
\t}
}
`,
    "Telegram/SourceFiles/storage/storage_account.h": `class Account {
public:
\t[[nodiscard]] QString tempDirectory() const;
};
`,
    "Telegram/SourceFiles/storage/storage_account.cpp": `QString Account::tempDirectory() const {
\treturn _tempPath;
}

base::flat_set<QString> Account::collectGoodNames() const {
\tauto result = base::flat_set<QString>{
\t\t"map0",
\t\t"configs",
\t};
\treturn result;
}
`,
    "Telegram/SourceFiles/main/main_account.h": `class Account {
public:
\tvoid destroyStaleAuthorizationKeys();
\tMTP::Instance::Fields _mtpFields;
};
`,
    "Telegram/SourceFiles/main/main_account.cpp": `#include "core/application.h"

void Account::start(std::unique_ptr<MTP::Config> config) {
\tstartMtp(std::move(config));
}

void Account::destroyStaleAuthorizationKeys() {
}
void serialize() {
\t\t\twriteKeys(stream, keysToDestroy);
}
void deserialize() {
\treadKeys(_mtpKeysToDestroy);
}
`,
    "Telegram/SourceFiles/intro/intro_widget.h": `namespace Ui {
class FlatLabel;
}

class Widget {
\tobject_ptr<Ui::FadeWrap<Ui::RoundButton>> _settings;
};
`,
    "Telegram/SourceFiles/intro/intro_widget.cpp": `#include "countries/countries_instance.h"
#include "ui/widgets/labels.h"

Widget::Widget()
: _settings(
\tthis,
\tobject_ptr<Ui::RoundButton>(
\t\tthis,
\t\trpl::single(u"Settings"_q),
\t\tst::defaultBoxButton))
, _next(
\tthis) {
\t_settings->entity()->setTextTransform(Ui::RoundButtonTextTransform::ToUpper);
}

void Widget::showAnimated() {
\t_settings->toggle(!stepHasCover, anim::type::normal);
}

void Widget::fixOrder() {
\t_next->raise();
\tif (_update) _update->raise();
\tif (_changeLanguage) _changeLanguage->raise();
\t_settings->raise();
}

void Widget::append() {
\tappendStep(step);
\t_back->raise();
\t_settings->raise();
}

void Widget::showInstant() {
\t_settings->toggle(!hasCover, anim::type::instant);
}

void Widget::hideInstant() {
\t_settings->hide(anim::type::instant);
}

void Widget::resizeEvent() {
\t_settings->moveToRight(skip, controlsTop + skip);
\tif (_testModeLabel) {
\t\t_testModeLabel->moveToRight(
\t\t\tskip + _settings->width() + skip,
\t\t\tcontrolsTop);
\t}
\tif (_update) {
\t\t_update->moveToRight(
\t\t\tskip + _settings->width() + skip,
\t\t\tcontrolsTop);
\t}
}
`,
  };
  files["Telegram/build/docker/centos_env/Dockerfile"] = "qtbase qtdeclarative qtwayland qtimageformats qtsvg qtshadertools\n";
  files["Telegram/SourceFiles/mtproto/session_private.cpp"] = `void connect() {
\tdestroyAllConnections();

\tif (realDcTypeChanged() && _keyCreator) {}
\tif (_options->proxy.type == ProxyData::Type::Mtproto) {}
}`;
  files["Telegram/SourceFiles/mtproto/connection_tcp.cpp"] = `#include "mtproto/details/mtproto_abstract_socket.h"
void connect() {
\t_protocolDcId = protocolDcId;
}
QString transport() {
\tauto result = u"TCP"_q;
\tif (qthelp::is_ipv6(_address)) {
\t\tresult += u"/IPv6"_q;
\t}
\treturn result;
}`;
  await Promise.all(Object.entries(files).map(async ([relative, source]) => {
    const destination = path.join(root, relative);
    await mkdir(path.dirname(destination), { recursive: true });
    await writeFile(destination, source, "utf8");
  }));
  return root;
}

describe("server switch patch", () => {
  it("retains the saved configuration during account cleanup", async () => {
    const root = await fixture();
    const options = {
      root,
      target: targetById("ayugram"),
      featureRoot: path.resolve("features/server-switch"),
    };

    await patchServerSwitch(options);
    const storagePath = path.join(
      root,
      "Telegram/SourceFiles/storage/storage_account.cpp",
    );
    const first = await readFile(storagePath, "utf8");
    expect(first).toContain('return _basePath + u"server-switch.json"_q;');
    expect(first.match(/"server-switch\.json",/g)).toHaveLength(1);

    const tcp = await readFile(path.join(root, "Telegram/SourceFiles/mtproto/connection_tcp.cpp"), "utf8");
    expect(tcp).toContain("std::make_unique<WssSocket>");
    const session = await readFile(path.join(root, "Telegram/SourceFiles/mtproto/session_private.cpp"), "utf8");
    expect(session).toContain("unmapped-or-cdn-dc");
    expect(session).toContain("serverSwitchBlocked()");
    expect(session).toContain("_options->proxy = ProxyData()");
    const account = await readFile(path.join(root, "Telegram/SourceFiles/main/main_account.cpp"), "utf8");
    expect(account).toContain("blockServerSwitchConfiguration()");
    expect(account).not.toContain("prepared->dcOptions().useBuiltInConfiguration()");
    expect(account).toContain("stream << quint32(0x43575331) << _serverSwitchIdentity");
    await patchServerSwitch(options);
    expect(await readFile(path.join(root, "Telegram/SourceFiles/mtproto/connection_tcp.cpp"), "utf8")).toBe(tcp);
    expect(await readFile(storagePath, "utf8")).toBe(first);
  });
});

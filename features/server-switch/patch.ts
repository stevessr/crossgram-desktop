import { PatchContext } from "../../src/core/patch-context.js";
import type { Target } from "../../src/targets.js";

import { patchWss } from "./wss-patch.js";

interface PatchOptions {
  readonly root: string;
  readonly target: Target;
  readonly featureRoot: string;
}

const sourceRoot = "Telegram/SourceFiles";

export async function patchServerSwitch(options: PatchOptions): Promise<void> {
  const context = new PatchContext(options.root, options.target, options.featureRoot);
  await context.install("server_switch.h", `${sourceRoot}/crossgram/server_switch.h`);
  await context.install("server_switch.cpp", `${sourceRoot}/crossgram/server_switch.cpp`);

  const [
    dcDeclarations,
    dcMethods,
    mainStart,
    mainReload,
    introInitializer,
    introSetup,
  ] = await Promise.all([
    context.fragment("dc-options-declarations.h"),
    context.fragment("dc-options-methods.cpp"),
    context.fragment("main-account-start.cpp"),
    context.fragment("main-account-reload.cpp"),
    context.fragment("intro-initializer.cpp"),
    context.fragment("intro-setup.cpp"),
  ]);

  await context.edit("Telegram/CMakeLists.txt", (file) => {
    file.insertAfter(
      "    countries/countries_manager.h",
      "\n    crossgram/server_switch.cpp\n    crossgram/server_switch.h",
      "crossgram/server_switch.cpp",
    );
  });

  await context.edit("Telegram/build/prepare/prepare.py", (file) => {
    file.replace(
      '    msbuild -m dump_syms.vcxproj /property:Configuration=Release /property:Platform="x64"',
      '    msbuild -m dump_syms.vcxproj /property:Configuration=Release /property:Platform="x64" /property:IncludePath="%INCLUDE%" /property:LibraryPath="%LIB%"',
      '/property:IncludePath="%INCLUDE%" /property:LibraryPath="%LIB%"',
    );
  });

  if (options.target.id === "tdesktop-x64") {
    await context.edit("cmake/external/cmark_gfm/CMakeLists.txt", (file) => {
      file.insertAfter(
        "    set(CMAKE_SKIP_INSTALL_RULES TRUE)",
        [
          "",
          "    # CMake 4.4 makes reads of the legacy deprecation variables below",
          "    # a CMP0218 error under tdesktop's strict diagnostics.",
          "    if (POLICY CMP0218)",
          "        cmake_policy(SET CMP0218 NEW)",
          "        set(CMAKE_POLICY_DEFAULT_CMP0218 NEW)",
          "        cmake_diagnostic(SET CMD_AUTHOR IGNORE RECURSE)",
          "    endif()",
        ].join("\n"),
        "cmake_policy(SET CMP0218 NEW)",
      );
    });
  }

  await context.edit(`${sourceRoot}/mtproto/mtproto_dc_options.h`, (file) => {
    file.insertAfter(
      "\t[[nodiscard]] bool isTestMode() const;",
      dcDeclarations,
      "specialConfigEnabled() const",
    );
    file.insertAfter(
      "\tbool _immutable = false;",
      "\n\tbool _specialConfigEnabled = true;",
      "_specialConfigEnabled = true",
    );
  });

  await context.edit(`${sourceRoot}/mtproto/mtproto_dc_options.cpp`, (file) => {
    file.replace(
      ", _immutable(other._immutable) {",
      ", _immutable(other._immutable)\n, _specialConfigEnabled(other._specialConfigEnabled) {",
      "_specialConfigEnabled(other._specialConfigEnabled)",
    );
    file.insertAfterFunction(
      "bool DcOptions::isTestMode() const",
      dcMethods,
      "bool DcOptions::specialConfigEnabled() const",
    );
  });

  await context.edit(`${sourceRoot}/mtproto/config_loader.cpp`, (file) => {
    file.replace(
      "\tif (_proxyEnabled || _instance->isKeysDestroyer()) {",
      "\tif (_proxyEnabled\n\t\t|| _instance->isKeysDestroyer()\n\t\t|| !_instance->dcOptions().specialConfigEnabled()) {",
      "!_instance->dcOptions().specialConfigEnabled()",
    );
  });

  await context.edit(`${sourceRoot}/storage/storage_account.h`, (file) => {
    const anchor = file.has("\t[[nodiscard]] QString supportModePath() const;")
      ? "\t[[nodiscard]] QString supportModePath() const;"
      : "\t[[nodiscard]] QString tempDirectory() const;";
    file.insertAfter(
      anchor,
      "\n\t[[nodiscard]] QString serverSwitchConfigPath() const;",
      "serverSwitchConfigPath() const",
    );
  });

  await context.edit(`${sourceRoot}/storage/storage_account.cpp`, (file) => {
    const signature = file.has("QString Account::supportModePath() const")
      ? "QString Account::supportModePath() const"
      : "QString Account::tempDirectory() const";
    file.insertAfterFunction(
      signature,
      "\n\nQString Account::serverSwitchConfigPath() const {\n\treturn _basePath + u\"server-switch.json\"_q;\n}",
      "QString Account::serverSwitchConfigPath() const",
    );
  });

  await context.edit(`${sourceRoot}/storage/storage_account.cpp`, (file) => {
    file.insertAfter(
      '\t\t"configs",',
      '\n\t\t"server-switch.json",',
      '"server-switch.json",',
    );
  });

  await context.edit(`${sourceRoot}/main/main_account.h`, (file) => {
    file.insertAfter(
      "\tvoid destroyStaleAuthorizationKeys();",
      "\n\t[[nodiscard]] bool reloadServerSwitchConfiguration(QString *error);",
      "reloadServerSwitchConfiguration(QString *error)",
    );
  });

  await context.edit(`${sourceRoot}/main/main_account.cpp`, (file) => {
    file.insertAfter(
      "#include \"core/application.h\"",
      "\n#include \"crossgram/server_switch.h\"",
      "#include \"crossgram/server_switch.h\"",
    );
    file.replaceFunction(
      "void Account::start(std::unique_ptr<MTP::Config> config)",
      mainStart.trim(),
      "Crossgram::ServerSwitch::ApplyStored(",
    );
    file.insertAfterFunction(
      "void Account::destroyStaleAuthorizationKeys()",
      mainReload,
      "bool Account::reloadServerSwitchConfiguration(QString *error)",
    );
  });

  await context.edit(`${sourceRoot}/intro/intro_widget.h`, (file) => {
    file.insertAfter("class FlatLabel;", "\nclass PopupMenu;", "class PopupMenu;");
    file.insertAfter(
      "\tobject_ptr<Ui::FadeWrap<Ui::RoundButton>> _settings;",
      "\n\tobject_ptr<Ui::FadeWrap<Ui::RoundButton>> _server;",
      "_server;",
    );
    const menuAnchor = file.has("_testModeLabel")
      ? "\tobject_ptr<Ui::FadeWrap<Ui::FlatLabel>> _testModeLabel = { nullptr };"
      : "\tobject_ptr<Ui::FadeWrap<Ui::RoundButton>> _server;";
    file.insertAfter(
      menuAnchor,
      "\n\tbase::unique_qptr<Ui::PopupMenu> _serverMenu;",
      "_serverMenu;",
    );
  });

  await context.edit(`${sourceRoot}/intro/intro_widget.cpp`, (file) => {
    file.insertAfter(
      "#include \"countries/countries_instance.h\"",
      "\n#include \"crossgram/server_switch.h\"",
      "#include \"crossgram/server_switch.h\"",
    );
    file.insertAfter(
      "#include \"ui/widgets/labels.h\"",
      "\n#include \"ui/widgets/popup_menu.h\"",
      "#include \"ui/widgets/popup_menu.h\"",
    );
    file.replace(
      "\t\tst::defaultBoxButton))\n, _next(",
      `\t\tst::defaultBoxButton))${introInitializer}`,
      ", _server(",
    );
    file.insertAfter(
      "\t_settings->entity()->setTextTransform(Ui::RoundButtonTextTransform::ToUpper);",
      introSetup,
      "Crossgram::ServerSwitch::FillMenu(",
    );
    file.insertAfter(
      "\t_settings->toggle(!stepHasCover, anim::type::normal);",
      "\n\t_server->toggle(!stepHasCover, anim::type::normal);",
      "_server->toggle(!stepHasCover, anim::type::normal)",
    );
    file.insertAfter(
      "\tif (_changeLanguage) _changeLanguage->raise();\n\t_settings->raise();",
      "\n\t_server->raise();",
      "void Widget::fixOrder() {\n\t_next->raise();\n\tif (_update) _update->raise();\n\tif (_changeLanguage) _changeLanguage->raise();\n\t_settings->raise();\n\t_server->raise();",
    );
    file.insertAfter(
      "\tappendStep(step);\n\t_back->raise();\n\t_settings->raise();",
      "\n\t_server->raise();",
      "\tappendStep(step);\n\t_back->raise();\n\t_settings->raise();\n\t_server->raise();",
    );
    file.insertAfter(
      "\t_settings->toggle(!hasCover, anim::type::instant);",
      "\n\t_server->toggle(!hasCover, anim::type::instant);",
      "_server->toggle(!hasCover, anim::type::instant)",
    );
    file.insertAfter(
      "\t_settings->hide(anim::type::instant);",
      "\n\t_server->hide(anim::type::instant);",
      "_server->hide(anim::type::instant)",
    );
    file.replace(
      "\t_settings->moveToRight(skip, controlsTop + skip);",
      "\t_settings->moveToRight(skip, controlsTop + skip);\n\tconst auto serverRight = skip + _settings->width() + skip;\n\t_server->moveToRight(serverRight, _settings->y());\n\tconst auto afterServerRight = serverRight + _server->width() + skip;",
      "const auto afterServerRight",
    );
    file.replace(
      "\tif (_testModeLabel) {\n\t\t_testModeLabel->moveToRight(\n\t\t\tskip + _settings->width() + skip,",
      "\tif (_testModeLabel) {\n\t\t_testModeLabel->moveToRight(\n\t\t\tafterServerRight,",
      "\tif (_testModeLabel) {\n\t\t_testModeLabel->moveToRight(\n\t\t\tafterServerRight,",
    );
    file.replace(
      "\tif (_update) {\n\t\t_update->moveToRight(\n\t\t\tskip + _settings->width() + skip,",
      "\tif (_update) {\n\t\t_update->moveToRight(\n\t\t\tafterServerRight,",
      "\tif (_update) {\n\t\t_update->moveToRight(\n\t\t\tafterServerRight,",
    );
  });
  await patchWss(context);
}

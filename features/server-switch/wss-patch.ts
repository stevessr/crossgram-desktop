import { PatchContext } from "../../src/core/patch-context.js";

const source = "Telegram/SourceFiles";

export async function patchWss(context: PatchContext): Promise<void> {
  for (const asset of ["server_configuration.h", "server_configuration.cpp", "wss_url.h", "wss_stream.h", "wss_stream.cpp", "wss_socket.h", "wss_socket.cpp"]) {
    await context.install(asset, `${source}/crossgram/${asset}`);
  }
  await context.edit("Telegram/CMakeLists.txt", file => {
    file.insertAfter("    crossgram/server_switch.h", "\n    crossgram/server_configuration.h\n    crossgram/server_configuration.cpp\n    crossgram/wss_url.h\n    crossgram/wss_stream.h\n    crossgram/wss_stream.cpp\n    crossgram/wss_socket.h\n    crossgram/wss_socket.cpp", "    crossgram/wss_socket.cpp");
    file.insertAfter("init_non_host_target(Telegram)", "\n\n# Crossgram WSS transport: required, never silently disable TLS transport.\nfind_package(Qt6 REQUIRED COMPONENTS WebSockets)\ntarget_link_libraries(Telegram PRIVATE Qt6::WebSockets)\n\n", "find_package(Qt6 REQUIRED COMPONENTS WebSockets)");
  });
  // Qt's superbuild only builds initialized modules (including static builds).
  await context.edit("Telegram/build/prepare/prepare.py", file => {
    for (const modules of ["qtbase qtimageformats qtsvg", "qtbase qtimageformats qtshadertools qtsvg"]) {
      file.replace(modules, `${modules} qtwebsockets`, `${modules} qtwebsockets`);
    }
  });
  await context.edit("Telegram/build/docker/centos_env/Dockerfile", file => {
    file.replace("qtbase qtdeclarative qtwayland qtimageformats qtsvg qtshadertools", "qtbase qtdeclarative qtwayland qtimageformats qtsvg qtshadertools qtwebsockets", "qtshadertools qtwebsockets");
  });
  await context.edit(`${source}/mtproto/mtproto_dc_options.h`, file => {
    file.insertAfter("\tbool _specialConfigEnabled = true;", "\n\tstd::map<DcId, QString> _websocketUrls;\n\tbool _serverSwitchBlocked = false;", "std::map<DcId, QString> _websocketUrls;");
  });
  await context.edit(`${source}/mtproto/mtproto_dc_options.cpp`, file => {
    file.replace(", _specialConfigEnabled(other._specialConfigEnabled) {", ", _specialConfigEnabled(other._specialConfigEnabled)\n, _websocketUrls(other._websocketUrls)\n, _serverSwitchBlocked(other._serverSwitchBlocked) {", "_websocketUrls(other._websocketUrls)");
  });
  await context.edit(`${source}/mtproto/session_private.cpp`, file => {
    // Explicit WSS selection bypasses TCP/HTTP racing, IP flags and global proxies.
    // Unmapped DCs MUST NOT fall back to Telegram, including media/CDN sessions.
    file.replace("\tdestroyAllConnections();\n\n\tif (realDcTypeChanged() && _keyCreator)", [
      "\tdestroyAllConnections();",
      "\tif (_instance->dcOptions().serverSwitchBlocked()) {",
      "\t\tsetState(DisconnectedState);",
      "\t\treturn; // Fail closed for this account, without affecting others.",
      "\t}",
      "",
      "\tif (realDcTypeChanged() && _keyCreator)",
    ].join("\n"), "_instance->dcOptions().serverSwitchBlocked()");
    const signature = "\tif (_options->proxy.type == ProxyData::Type::Mtproto";
    file.replace(signature, [
      "\tif (_instance->dcOptions().websocketTransport()) {",
      "\t\t_options->proxy = ProxyData();",
      "\t\tconst auto url = _instance->dcOptions().websocketUrl(bareDc);",
      "\t\tif (url.isEmpty() || _currentDcType == DcType::Cdn) {",
      '\t\t\tLOG(("WSS transport error: unmapped-or-cdn-dc"));',
      "\t\t\treturn restart();",
      "\t\t}",
      "\t\tappendTestConnection(DcOptions::Variants::Tcp, {}, 0, {});",
      "\t} else if (_options->proxy.type == ProxyData::Type::Mtproto",
    ].join("\n"), "WSS transport error: unmapped-or-cdn-dc");
  });
  await context.edit(`${source}/mtproto/connection_tcp.cpp`, file => {
    file.insertAfter('#include "mtproto/details/mtproto_abstract_socket.h"', '\n#include "crossgram/wss_socket.h"\n#include "mtproto/mtp_instance.h"', '#include "crossgram/wss_socket.h"');
    file.insertAfter("\t_protocolDcId = protocolDcId;", [
      "",
      "\tif (_instance->dcOptions().websocketTransport()) {",
      "\t\tconst auto id = std::abs(int(protocolDcId));",
      "\t\tconst auto dc = id > kTestModeDcIdShift ? id - kTestModeDcIdShift : id;",
      "\t\t_protocol = Protocol::Create({}); // obfuscated abridged, no MTProxy secret",
      "\t\t_socket = std::make_unique<WssSocket>(thread(),",
      "\t\t\tQUrl(_instance->dcOptions().websocketUrl(dc), QUrl::StrictMode));",
      "\t}",
    ].join("\n"), "std::make_unique<WssSocket>");
    file.replace('\tauto result = u"TCP"_q;\n\tif (qthelp::is_ipv6(_address)) {\n\t\tresult += u"/IPv6"_q;\n\t}\n\treturn result;', '\tauto result = _instance->dcOptions().websocketTransport() ? u"WSS"_q : u"TCP"_q;\n\tif (qthelp::is_ipv6(_address)) {\n\t\tresult += u"/IPv6"_q;\n\t}\n\treturn result;', 'websocketTransport() ? u"WSS"_q');
    // tag() is separate; replace() requires a unique anchor.
  });
  await context.edit(`${source}/main/main_account.h`, file => {
    file.insertAfter("\tMTP::Instance::Fields _mtpFields;", "\n\tQByteArray _serverSwitchIdentity;", "QByteArray _serverSwitchIdentity;");
  });
  await context.edit(`${source}/main/main_account.cpp`, file => {
    // Append-only extension INSIDE the existing encrypted authorization record.
    file.insertAfter("\t\t\twriteKeys(stream, keysToDestroy);", "\n\t\t\tif (!_serverSwitchIdentity.isEmpty()) {\n\t\t\t\tstream << quint32(0x43575331) << _serverSwitchIdentity;\n\t\t\t}", "stream << quint32(0x43575331)");
    file.insertAfter("\treadKeys(_mtpKeysToDestroy);", [
      "",
      "\tif (!stream.atEnd()) {",
      "\t\tquint32 tag = 0;",
      "\t\tstream >> tag >> _serverSwitchIdentity;",
      "\t\tif (stream.status() != QDataStream::Ok || tag != 0x43575331",
      "\t\t\t|| (_serverSwitchIdentity != QByteArray(\"official\") && _serverSwitchIdentity.size() != 64)) {",
      '\t\t\tqFatal("Invalid encrypted server identity binding; refusing to connect.");',
      "\t\t}",
      "\t}",
    ].join("\n"), "Invalid encrypted server identity binding");
  });
}

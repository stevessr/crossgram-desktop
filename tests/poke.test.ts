import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { patchPoke } from "../features/poke/patch.js";
import { targetById } from "../src/targets.js";

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "crossgram-desktop-poke-"));
  roots.push(root);
  const files: Record<string, string> = {
    "Telegram/CMakeLists.txt": "set(SOURCES\n    mainwidget.cpp\n    main.cpp\n)\n",
    "Telegram/SourceFiles/mtproto/scheme/api.tl":
      "---functions---\nupload.getFile#be5335be flags:# precise:flags.0?true cdn_supported:flags.1?true location:InputFileLocation offset:long limit:int = upload.File;\n",
    "Telegram/SourceFiles/codegen/scheme/codegen_scheme.py":
      "builtin = [\n    'messageReplies#81834865',\n]\n",
    "Telegram/SourceFiles/window/window_peer_menu.cpp": [
      '#include "window/window_peer_menu.h"',
      '#include "apiwrap.h"',
      "",
      "void FillSenderUserpicMenu(",
      "\t\tnot_null<SessionController*> controller,",
      "\t\tnot_null<PeerData*> peer,",
      "\t\tPeerData *groupPeer,",
      "\t\tUi::InputField *fieldForMention,",
      "\t\tDialogs::Key searchInEntry,",
      "\t\tconst PeerMenuCallback &addAction) {",
      "\tif (searchInEntry) {",
      "\t\taddAction(tr::lng_context_search_from(tr::now), [=] {",
      "\t\t\tcontroller->searchInChat(searchInEntry, peer);",
      "\t\t}, &st::menuIconSearch);",
      "\t}",
      "}",
      "",
      "void Filler::fillHistoryActions() {",
      "\taddToggleMuteSubmenu(true);",
      "\taddInfo();",
      "}",
      "",
      "void Filler::fillProfileActions() {",
      "\taddTTLSubmenu(true);",
      "\taddSupportInfo();",
      "}",
      "",
    ].join("\n"),
    "Telegram/SourceFiles/window/window_session_controller.cpp": [
      '#include "window/window_session_controller.h"',
      '#include "apiwrap.h"',
      "",
      "void SessionNavigation::showPeerHistory(",
      "\t\tnot_null<PeerData*> peer,",
      "\t\tconst SectionShow &params,",
      "\t\tMsgId msgId) {",
      "\tshowPeerHistory(peer->id, params, msgId);",
      "}",
      "",
    ].join("\n"),
  };
  await Promise.all(Object.entries(files).map(async ([relative, content]) => {
    const file = path.join(root, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content, "utf8");
  }));
  return root;
}

async function snapshot(root: string): Promise<Record<string, string>> {
  const relativePaths = [
    "Telegram/CMakeLists.txt",
    "Telegram/SourceFiles/mtproto/scheme/api.tl",
    "Telegram/SourceFiles/codegen/scheme/codegen_scheme.py",
    "Telegram/SourceFiles/window/window_peer_menu.cpp",
    "Telegram/SourceFiles/window/window_session_controller.cpp",
  ];
  const entries = await Promise.all(relativePaths.map(async (relative) =>
    [relative, await readFile(path.join(root, relative), "utf8")] as const));
  return Object.fromEntries(entries);
}

describe("poke desktop patch", () => {
  it("uses Qt6 QByteArray JSON input and the full PopupMenu definition", async () => {
    const source = await readFile(new URL("../features/poke/poke.cpp", import.meta.url), "utf8");
    expect(source).toContain('#include "ui/widgets/popup_menu.h"');
    expect(source).toContain("QJsonDocument::fromJson(data.vdata().v)");
    expect(source).not.toContain("data.vdata().v.toUtf8()");
  });

  it("installs the feature, wires both menus, and is idempotent", async () => {
    const root = await fixture();
    const options = { root, target: targetById("ayugram"), featureRoot: path.resolve("features/poke") };
    await patchPoke(options);
    const first = await snapshot(root);

    expect(first["Telegram/CMakeLists.txt"]).toContain("crossgram/poke.cpp");
    expect(first["Telegram/SourceFiles/mtproto/scheme/api.tl"]).toContain(
      "crossgram.getFeatures#c3e6b915 peer:InputPeer = DataJSON;",
    );
    expect(first["Telegram/SourceFiles/mtproto/scheme/api.tl"]).toContain(
      "crossgram.sendPoke#9a2d47f0 peer:InputPeer user_id:InputUser count:int = Bool;",
    );
    expect(first["Telegram/SourceFiles/codegen/scheme/codegen_scheme.py"]).toContain(
      "    'crossgram.sendPoke#9a2d47f0',",
    );
    const menu = first["Telegram/SourceFiles/window/window_peer_menu.cpp"] ?? "";
    expect(menu).toContain('#include "crossgram/poke.h"');
    expect(menu).toContain("\tCrossgram::Poke::AddMenuAction(\n\t\tcontroller,\n\t\tpeer,\n\t\tgroupPeer ? groupPeer : peer.get(),\n\t\taddAction);");
    expect(menu.match(/Crossgram::Poke::AddMenuAction\(_controller, _peer, _peer, _addAction\);/g) ?? [])
      .toHaveLength(2);
    const controller = first["Telegram/SourceFiles/window/window_session_controller.cpp"] ?? "";
    expect(controller).toContain("\tCrossgram::Poke::Warm(&peer->session(), peer);");
    expect(await readFile(path.join(root, "Telegram/SourceFiles/crossgram/poke.cpp"), "utf8"))
      .toContain("MTPcrossgram_SendPoke(");

    await patchPoke(options);
    expect(await snapshot(root)).toEqual(first);
  });

  it.each(["tdesktop", "materialgram"])("patches %s target", async (targetId) => {
    const root = await fixture();
    await patchPoke({ root, target: targetById(targetId), featureRoot: path.resolve("features/poke") });
    const sources = await snapshot(root);
    expect(sources["Telegram/SourceFiles/mtproto/scheme/api.tl"]).toContain("crossgram.getFeatures#c3e6b915");
    expect(sources["Telegram/SourceFiles/window/window_peer_menu.cpp"]).toContain("Crossgram::Poke::AddMenuAction");
    expect(sources["Telegram/SourceFiles/window/window_session_controller.cpp"]).toContain("Crossgram::Poke::Warm");
  });
});

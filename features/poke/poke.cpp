#include "crossgram/poke.h"

#include "apiwrap.h"
#include "base/basic_types.h"
#include "base/weak_ptr.h"
#include "data/data_peer.h"
#include "data/data_session.h"
#include "data/data_user.h"
#include "logs.h"
#include "main/main_session.h"
#include "mtproto/facade.h"
#include "window/window_session_controller.h"
#include "ui/widgets/popup_menu.h"

#include <QtCore/QDateTime>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QJsonValue>

#include <map>
#include <memory>
#include <optional>

namespace Crossgram::Poke {
namespace {

/** Burst sizes the menu offers; the relay caps them with its own maxCount. */
constexpr int kCounts[] = { 1, 5, 10 };

/** Probes that never arrive are repeated no faster than this. */
constexpr auto kProbeDelayMs = qint64(60 * 60 * 1000);

enum class Support {
	Unknown,
	Supported,
	Unsupported,
};

struct ConversationState {
	Support support = Support::Unknown;
	int maxCount = 0;
	qint64 requestedAt = 0;
};

struct SessionState {
	explicit SessionState(not_null<Main::Session*> session) : session(session) {
	}

	/** Identifies the owning session, so a recycled address never matches. */
	base::weak_ptr<Main::Session> session;

	/** The relay rejected the feature query: this server has no Crossgram API. */
	bool unavailable = false;

	std::map<uint64, ConversationState> conversations;
};

std::map<Main::Session*, std::unique_ptr<SessionState>> &States() {
	static auto result = std::map<Main::Session*, std::unique_ptr<SessionState>>();
	return result;
}

SessionState &StateFor(not_null<Main::Session*> session) {
	auto &states = States();
	const auto i = states.find(session);
	if (i != end(states) && i->second->session.get() == session) {
		return *i->second;
	}
	auto state = std::make_unique<SessionState>(session);
	const auto result = state.get();
	states[session] = std::move(state);
	return *result;
}

/** Read `{"poke":{"maxCount":n}}` from the relay's feature payload. */
std::optional<int> ParseMaxCount(const MTPDataJSON &result) {
	return result.match([](const MTPDdataJSON &data) {
		const auto document = QJsonDocument::fromJson(data.vdata().v);
		const auto poke = document.isObject()
			? document.object().value(QStringLiteral("poke"))
			: QJsonValue();
		const auto maxCount = poke.isObject()
			? poke.toObject().value(QStringLiteral("maxCount"))
			: QJsonValue();
		if (!maxCount.isDouble()) {
			return std::optional<int>();
		}
		const auto value = int(maxCount.toDouble());
		return (value > 0) ? std::make_optional(value) : std::optional<int>();
	});
}

void ApplyFeatures(not_null<Main::Session*> session, PeerId peerId, std::optional<int> maxCount) {
	auto &state = StateFor(session).conversations[peerId.value];
	if (maxCount && *maxCount > 0) {
		state.support = Support::Supported;
		state.maxCount = *maxCount;
	} else {
		state.support = Support::Unsupported;
		state.maxCount = 0;
	}
}

void Probe(not_null<Main::Session*> session, PeerId peerId, not_null<PeerData*> conversation) {
	session->api().request(MTPcrossgram_GetFeatures(
		conversation->input()
	)).done([=](const MTPDataJSON &result) {
		ApplyFeatures(session, peerId, ParseMaxCount(result));
	}).fail([=](const MTP::Error &error) {
		// A server without the Crossgram API answers an unknown method with an
		// error; remember that and stop querying it for this session.
		LOG(("Crossgram feature query failed: %1").arg(error.type()));
		StateFor(session).unavailable = true;
		ApplyFeatures(session, peerId, std::nullopt);
	}).send();
}

void EnsureProbed(not_null<Main::Session*> session, not_null<PeerData*> conversation) {
	auto &state = StateFor(session);
	if (state.unavailable) {
		return;
	}
	const auto now = QDateTime::currentMSecsSinceEpoch();
	auto &conversationState = state.conversations[conversation->id.value];
	if (conversationState.support != Support::Unknown) {
		return;
	} else if (conversationState.requestedAt
		&& (now - conversationState.requestedAt < kProbeDelayMs)) {
		return;
	}
	conversationState.requestedAt = now;
	Probe(session, conversation->id, conversation);
}

ConversationState *FindState(not_null<Main::Session*> session, PeerId peerId) {
	auto &conversations = StateFor(session).conversations;
	const auto i = conversations.find(peerId.value);
	return (i != end(conversations)) ? &i->second : nullptr;
}

void SendPoke(
		not_null<Main::Session*> session,
		not_null<PeerData*> conversation,
		not_null<UserData*> target,
		int count,
		base::weak_ptr<Window::SessionController> controller) {
	// The relay answers with Bool and publishes QQ's poke notice as a regular
	// message update, so a successful send needs no extra UI.
	session->api().request(MTPcrossgram_SendPoke(
		conversation->input(),
		target->inputUser(),
		MTP_int(count)
	)).fail([=](const MTP::Error &error) {
		LOG(("Crossgram poke failed: %1").arg(error.type()));
		if (const auto strong = controller.get()) {
			strong->showToast(u"戳一戳发送失败"_q);
		}
	}).send();
}

} // namespace

void Warm(not_null<Main::Session*> session, not_null<PeerData*> conversation) {
	if (conversation->isBroadcast()) {
		return;
	}
	EnsureProbed(session, conversation);
}

void AddMenuAction(
		not_null<Window::SessionController*> controller,
		PeerData *target,
		PeerData *conversation,
		const Ui::Menu::MenuCallback &addAction) {
	if (!target || !conversation || !target->isUser() || target->isSelf()) {
		return;
	}
	const auto session = &controller->session();
	const auto maxCount = [&] {
		const auto state = FindState(session, conversation->id);
		return (state && state->support == Support::Supported) ? state->maxCount : 0;
	}();
	if (maxCount <= 0) {
		EnsureProbed(session, conversation);
		return;
	}
	const auto weakSession = base::make_weak(session);
	const auto weakController = base::make_weak(controller.get());
	const auto targetId = target->id;
	const auto conversationId = conversation->id;
	const auto poke = [=](int count) {
		const auto session = weakSession.get();
		if (!session) {
			return;
		}
		const auto conversation = session->data().peer(conversationId);
		const auto target = session->data().peer(targetId);
		if (target->isUser() && !target->isSelf()) {
			SendPoke(session, conversation, target->asUser(), count, weakController);
		}
	};
	addAction(Ui::Menu::MenuCallback::Args{
		.text = u"戳一戳"_q,
		.handler = [=] { poke(1); },
		.icon = nullptr,
		.fillSubmenu = [=](not_null<Ui::PopupMenu*> menu) {
			for (const auto count : kCounts) {
				if (count > maxCount) {
					continue;
				}
				menu->addAction(u"%1 次"_q.arg(count), [=] { poke(count); });
			}
		},
	});
}

} // namespace Crossgram::Poke

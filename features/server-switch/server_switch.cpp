#include "crossgram/server_switch.h"
#include "crossgram/server_configuration.h"

#include "base/bytes.h"
#include "main/main_account.h"
#include "mtproto/details/mtproto_rsa_public_key.h"
#include "mtproto/mtproto_dc_options.h"
#include "storage/storage_account.h"
#include "ui/layers/generic_box.h"
#include "ui/widgets/fields/input_field.h"
#include "ui/widgets/buttons.h"
#include "window/window_controller.h"

#include "styles/style_boxes.h"
#include "styles/style_layers.h"

#include <QtCore/QDir>
#include <QtCore/QFile>
#include <QtCore/QFileInfo>
#include <QtCore/QSaveFile>
#include <QtGui/QClipboard>
#include <QtGui/QGuiApplication>

namespace Crossgram::ServerSwitch {
namespace {

[[nodiscard]] bool Fail(QString *error, QString text) {
	if (error) *error = std::move(text);
	return false;
}

[[nodiscard]] bool Parse(const QByteArray &json, Configuration *result, QString *error) {
	return ParseServerConfiguration(json, result, error, [](const QByteArray &key) {
		// Upstream's unknown PEM format is a fatal programming error, not a
		// user input validation path. Reject it before invoking that parser.
		if (!key.contains("BEGIN RSA PUBLIC KEY") && !key.contains("BEGIN PUBLIC KEY")) return false;
		const auto parsed = MTP::details::RSAPublicKey(bytes::make_span(key));
		return parsed.valid() && parsed.getN().size() == 256;
	});
}

[[nodiscard]] bool Load(
		const QString &path,
		Configuration *result,
		QString *error) {
	auto file = QFile(path);
	if (!file.open(QIODevice::ReadOnly)) {
		return Fail(error, u"Could not read %1: %2"_q
			.arg(path, file.errorString()));
	}
	if (file.size() > 1024 * 1024) return Fail(error, u"Configuration exceeds 1 MiB."_q);
	return Parse(file.readAll(), result, error);
}

[[nodiscard]] bool Write(
		const QString &path,
		const QByteArray &json,
		QString *error) {
	const auto directory = QFileInfo(path).dir();
	if (!directory.exists() && !QDir().mkpath(directory.absolutePath())) {
		return Fail(error, u"Could not create %1."_q
			.arg(directory.absolutePath()));
	}
	auto file = QSaveFile(path);
	if (!file.open(QIODevice::WriteOnly)
		|| file.write(json) != json.size()
		|| !file.commit()) {
		return Fail(error, u"Could not write %1: %2"_q
			.arg(path, file.errorString()));
	}
	return true;
}

void ShowEditor(
		not_null<Ui::GenericBox*> box,
		not_null<Window::Controller*> controller,
		not_null<Main::Account*> account) {
	box->setWidth(st::boxWideWidth);
	box->setTitle(u"Add server configuration"_q);
	const auto field = box->addRow(object_ptr<Ui::InputField>(
		box,
		st::newGroupDescription,
		Ui::InputField::Mode::MultiLine,
		rpl::single(u"Paste the server JSON configuration"_q),
		QString()));
	field->setSubmitSettings(Ui::InputField::SubmitSettings::None);
	box->setFocusCallback([=] { field->setFocusFast(); });

	const auto submit = [=] {
		if (account->sessionExists()) return;
		const auto json = field->getLastText().toUtf8();
		auto parsed = Configuration();
		auto error = QString();
		if (!Parse(json, &parsed, &error)
			|| !Write(account->local().serverSwitchConfigPath(), json, &error)
			|| !account->reloadServerSwitchConfiguration(&error)) {
			field->showErrorNoFocus();
			controller->showToast(error);
			return;
		}
		box->closeBox();
		controller->showToast(u"Server configuration applied to this account."_q);
	};

	box->addButton(rpl::single(u"Confirm"_q), submit);
	box->addButton(rpl::single(u"Read from clipboard"_q), [=] {
		field->setText(QGuiApplication::clipboard()->text());
		field->setFocusFast();
	});
	box->addButton(rpl::single(u"Cancel"_q), [=] { box->closeBox(); });
}

void UseOfficial(
		not_null<Window::Controller*> controller,
		not_null<Main::Account*> account) {
	if (account->sessionExists()) return;
	const auto path = account->local().serverSwitchConfigPath();
	if (QFile::exists(path) && !QFile::remove(path)) {
		controller->showToast(u"Could not remove the custom configuration."_q);
		return;
	}
	auto error = QString();
	if (!account->reloadServerSwitchConfiguration(&error)) {
		controller->showToast(error);
		return;
	}
	controller->showToast(u"Official Telegram configuration applied."_q);
}

} // namespace

bool ApplyStored(
		const QString &path,
		not_null<MTP::DcOptions*> options,
		QString *error,
		QByteArray *identity) {
	if (!QFile::exists(path)) {
		options->useBuiltInConfiguration();
		if (identity) *identity = QByteArray("official");
		return true;
	}
	auto configuration = Configuration();
	if (!Load(path, &configuration, error)) {
		return false;
	}
	auto endpoints = std::vector<MTP::DcOptions::Endpoint>();
	for (const auto &endpoint : configuration.endpoints) {
		endpoints.emplace_back(endpoint.id, MTP::DcOptions::Flag::f_static,
			endpoint.address.toStdString(), endpoint.port, bytes::vector());
	}
	if (!options->useCustomConfiguration(
			endpoints,
			configuration.rsaKey,
			configuration.enableSpecialConfig,
			configuration.websocketUrls)) {
		return Fail(error, u"The custom MTProto configuration is invalid."_q);
	}
	if (identity) *identity = ConfigurationIdentity(configuration);
	return true;
}

namespace {

// Use the existing in-app layer, not a native Qt::Popup window. Creating a
// separate popup is unsafe on some Wayland/EGL combinations.
void ShowSelector(
		not_null<Ui::GenericBox*> box,
		not_null<Window::Controller*> controller,
		not_null<Main::Account*> account) {
	box->setWidth(st::boxWideWidth);
	box->setTitle(u"Server"_q);
	if (account->sessionExists()) {
		box->addButton(rpl::single(u"Close"_q), [=] { box->closeBox(); });
		return;
	}
	const auto official = box->addRow(
		object_ptr<Ui::LinkButton>(box, u"Official Telegram"_q));
	official->setClickedCallback([=] {
		UseOfficial(controller, account);
		box->closeBox();
	});
	const auto path = account->local().serverSwitchConfigPath();
	if (QFile::exists(path)) {
		auto configuration = Configuration();
		auto error = QString();
		const auto title = Load(path, &configuration, &error)
			? configuration.name
			: u"Invalid custom configuration"_q;
		const auto custom = box->addRow(
			object_ptr<Ui::LinkButton>(box, title));
		custom->setClickedCallback([=] {
			auto applyError = QString();
			if (!account->reloadServerSwitchConfiguration(&applyError)) {
				controller->showToast(applyError);
			} else {
				controller->showToast(u"Server configuration applied."_q);
			}
			box->closeBox();
		});
	}
	const auto add = box->addRow(
		object_ptr<Ui::LinkButton>(box, u"Add custom configuration..."_q));
	add->setClickedCallback([=] {
		box->closeBox();
		controller->show(Box(ShowEditor, controller, account));
	});
	box->addButton(rpl::single(u"Cancel"_q), [=] { box->closeBox(); });
}

} // namespace

void OpenSelector(
		not_null<Window::Controller*> controller,
		not_null<Main::Account*> account) {
	controller->show(Box(ShowSelector, controller, account));
}

} // namespace Crossgram::ServerSwitch

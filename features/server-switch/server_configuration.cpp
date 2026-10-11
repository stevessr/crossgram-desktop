#include "server_configuration.h"
#include "wss_url.h"
#include <QtCore/QJsonArray>
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <set>
#include <QtCore/QCryptographicHash>
#include <QtCore/QDataStream>
#include <QtCore/QIODevice>
#include <algorithm>

namespace Crossgram::ServerSwitch {
[[nodiscard]] bool Fail(QString *error, QString text) {
	if (error) {
		*error = std::move(text);
	}
	return false;
}

[[nodiscard]] bool ReadPort(
		const QJsonValue &value,
		int *result) {
	if (!value.isDouble()) {
		return false;
	}
	const auto number = value.toDouble();
	if (number < 1 || number > 65535) return false;
	const auto integer = int(number);
	if (number != integer || integer < 1 || integer > 65535) {
		return false;
	}
	*result = integer;
	return true;
}

[[nodiscard]] bool ReadAddress(
		const QJsonValue &value,
		QString *result) {
	if (!value.isString()) {
		return false;
	}
	const auto address = value.toString().trimmed();
	if (QHostAddress(address).isNull()) {
		return false;
	}
	*result = address;
	return true;
}

bool ParseServerConfiguration(
		const QByteArray &json,
		Configuration *result,
		QString *error,
		const std::function<bool(const QByteArray &)> &validateRsa) {
	if (json.size() > 1024 * 1024) return Fail(error, QStringLiteral("Configuration exceeds 1 MiB."));
	auto parseError = QJsonParseError();
	const auto document = QJsonDocument::fromJson(json, &parseError);
	if (parseError.error != QJsonParseError::NoError || !document.isObject()) {
		return Fail(error, QStringLiteral("Configuration must be a JSON object: %1")
			.arg(parseError.errorString()));
	}

	const auto object = document.object();
	auto parsed = Configuration();
	parsed.name = object.value(QStringLiteral("name")).toString().trimmed();
	if (parsed.name.isEmpty()) {
		return Fail(error, QStringLiteral("name must be a non-empty string."));
	}
	if (!object.value(QStringLiteral("enable_special_config")).isBool()) {
		return Fail(error, QStringLiteral("enable_special_config must be a boolean."));
	}
	parsed.enableSpecialConfig = object.value(
		QStringLiteral("enable_special_config")).toBool();
	const auto transportValue = object.value(QStringLiteral("transport"));
	if (!transportValue.isUndefined() && !transportValue.isString()) {
		return Fail(error, QStringLiteral("transport must be tcp or websocket."));
	}
	const auto transport = transportValue.toString(QStringLiteral("tcp"));
	const auto websocket = transport == u"websocket";
	if (transport != u"tcp" && !websocket) {
		return Fail(error, QStringLiteral("transport must be tcp or websocket."));
	}
	auto defaultUrl = QUrl();
	if (websocket) {
		if (parsed.enableSpecialConfig || object.contains(QStringLiteral("host"))
			|| object.contains(QStringLiteral("port"))
			|| !Crossgram::ParseWssUrl(object.value(QStringLiteral("websocket_url")).toString(), &defaultUrl)) {
			return Fail(error, QStringLiteral("WSS requires a strict wss DNS URL with path, no host/port fields, and enable_special_config=false."));
		}
	} else {
		if (object.contains(QStringLiteral("websocket_url"))) {
			return Fail(error, QStringLiteral("websocket_url requires transport=websocket."));
		}
		if (!ReadAddress(object.value(QStringLiteral("host")), &parsed.host)) {
			return Fail(error, QStringLiteral("host must be a valid IPv4 or IPv6 address."));
		}
		if (!ReadPort(object.value(QStringLiteral("port")), &parsed.port)) {
			return Fail(error, QStringLiteral("port must be an integer between 1 and 65535."));
		}
	}
	if (!object.value(QStringLiteral("rsa_key")).isString()) {
		return Fail(error, QStringLiteral("rsa_key must be a PEM string."));
	}
	parsed.rsaKey = object.value(QStringLiteral("rsa_key")).toString().toUtf8();
	if (!validateRsa(parsed.rsaKey)) {
		return Fail(error, QStringLiteral("rsa_key is not a valid RSA public key."));
	}

	auto dcsValue = object.value(QStringLiteral("dcs"));
	if (websocket && dcsValue.isUndefined()) {
		auto defaults = QJsonArray();
		for (auto id = 1; id <= 5; ++id) {
			auto dc = QJsonObject();
			dc.insert(QStringLiteral("id"), id);
			defaults.append(dc);
		}
		dcsValue = defaults;
	}
	if (!dcsValue.isArray() || dcsValue.toArray().isEmpty()) {
		return Fail(error, QStringLiteral("dcs must be a non-empty array."));
	}
	auto ids = std::set<int>();
	for (const auto &value : dcsValue.toArray()) {
		if (!value.isObject()) {
			return Fail(error, QStringLiteral("Every dcs entry must be an object."));
		}
		const auto dc = value.toObject();
		const auto idValue = dc.value(QStringLiteral("id"));
		if (!idValue.isDouble()) {
			return Fail(error, QStringLiteral("Every dcs entry needs an integer id."));
		}
		const auto idNumber = idValue.toDouble();
		if (idNumber < 1 || idNumber > 1000) return Fail(error, QStringLiteral("Invalid DC id."));
		const auto id = int(idNumber);
		if (idNumber != id || id < 1 || id > 1000 || ids.contains(id)) {
			return Fail(error, QStringLiteral("DC ids must be unique integers from 1 to 1000."));
		}
		ids.emplace(id);
		auto address = QString();
		auto port = 0;
		if (websocket) {
			if (dc.contains(QStringLiteral("ip")) || dc.contains(QStringLiteral("port"))) {
				return Fail(error, QStringLiteral("WSS DC entries cannot contain TCP addresses."));
			}
			auto url = defaultUrl;
			if (dc.contains(QStringLiteral("websocket_url"))
				&& !Crossgram::ParseWssUrl(dc.value(QStringLiteral("websocket_url")).toString(), &url)) {
				return Fail(error, QStringLiteral("Invalid DC websocket_url."));
			}
			parsed.websocketUrls.emplace(id, url.toString(QUrl::FullyEncoded));
			// Metadata only, never dialled: session selection bypasses lookup.
			address = QStringLiteral("0.0.0.0");
			port = 443;
		} else {
			if (dc.contains(QStringLiteral("websocket_url"))
				|| !ReadAddress(dc.value(QStringLiteral("ip")), &address)
				|| !ReadPort(dc.value(QStringLiteral("port")), &port)) {
				return Fail(error, QStringLiteral("Every TCP DC entry needs a valid ip and port."));
			}
		}
		parsed.endpoints.push_back({ id, address, port });
	}

	if (websocket && !ids.contains(2)) {
		return Fail(error, QStringLiteral("WSS DC mapping must include initial DC 2."));
	}
	*result = std::move(parsed);
	return true;
}


QByteArray ConfigurationIdentity(const Configuration &config) {
	// Length-delimited canonical fields: URLs may themselves contain ':' or ';'.
	// Concatenating delimited strings would permit ambiguous identity encodings.
	auto canonical = QByteArray();
	QDataStream stream(&canonical, QIODevice::WriteOnly);
	stream.setVersion(QDataStream::Qt_5_1);
	stream << bool(!config.websocketUrls.empty()) << config.rsaKey << config.enableSpecialConfig;
	auto endpoints = config.endpoints;
	std::sort(endpoints.begin(), endpoints.end(), [](const auto &a, const auto &b) { return a.id < b.id; });
	stream << quint32(endpoints.size());
	for (const auto &endpoint : endpoints) {
		stream << qint32(endpoint.id) << endpoint.address << qint32(endpoint.port);
	}
	stream << quint32(config.websocketUrls.size());
	for (const auto &[id, url] : config.websocketUrls) {
		stream << qint32(id) << url;
	}
	return QCryptographicHash::hash(canonical, QCryptographicHash::Sha256).toHex();
}

} // namespace Crossgram::ServerSwitch

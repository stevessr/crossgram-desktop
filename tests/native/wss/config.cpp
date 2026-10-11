#include "server_configuration.h"
#include <QtCore/QJsonDocument>
#include <QtCore/QJsonObject>
#include <QtCore/QJsonArray>
#include <stdexcept>
using namespace Crossgram::ServerSwitch;
void configTests() {
	auto require = [](bool ok) { if (!ok) throw std::runtime_error("configuration/identity regression"); };
	QJsonObject wss{{"name", "Test"}, {"transport", "websocket"}, {"websocket_url", "wss://x.example.test:8443/mtproto?a=b"}, {"enable_special_config", false}, {"rsa_key", "test-public-key"}};
	auto parse = [](QJsonObject object, Configuration *result) {
		QString error;
		return ParseServerConfiguration(QJsonDocument(object).toJson(), result, &error,
			[](const QByteArray &key) { return key == "test-public-key"; });
	};
	Configuration result;
	require(parse(wss, &result) && result.websocketUrls.size() == 5);
	require(result.websocketUrls.at(2) == QStringLiteral("wss://x.example.test:8443/mtproto?a=b"));
	const auto identity = ConfigurationIdentity(result);
	for (const auto &field : {"host", "port"}) { auto bad = wss; bad[field] = 443; require(!parse(bad, &result)); }
	for (const auto &transport : {"http", "", "Websocket"}) { auto bad = wss; bad["transport"] = transport; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["transport"] = 1; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["enable_special_config"] = true; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["rsa_key"] = "invalid"; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["dcs"] = QJsonArray(); require(!parse(bad, &result)); }
	for (const auto id : {0., 1001., 1.5, 1e100}) {
		auto bad = wss; bad["dcs"] = QJsonArray{ QJsonObject{{"id", id}} }; require(!parse(bad, &result));
	}
	{ auto bad = wss; bad["dcs"] = QJsonArray{ QJsonObject{{"id", 2}}, QJsonObject{{"id", 2}} }; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["dcs"] = QJsonArray{ QJsonObject{{"id", 1}} }; require(!parse(bad, &result)); }
	{ auto bad = wss; bad["dcs"] = QJsonArray{ QJsonObject{{"id", 2}, {"ip", "1.2.3.4"}} }; require(!parse(bad, &result)); }
	{ auto good = wss; good["dcs"] = QJsonArray{QJsonObject{{"id", 2}, {"websocket_url", "wss://dc2.example.test/transport"}}}; require(parse(good, &result)); require(result.websocketUrls.at(2) == QStringLiteral("wss://dc2.example.test/transport")); }
	{ auto good = wss; good["name"] = "Renamed"; require(parse(good, &result)); require(ConfigurationIdentity(result) == identity); }
	{ auto good = wss; good["websocket_url"] = "wss://other.example.test/mtproto"; require(parse(good, &result)); require(ConfigurationIdentity(result) != identity); }
	QJsonObject tcp{{"name", "Legacy"}, {"host", "192.0.2.1"}, {"port", 4430}, {"rsa_key", "test-public-key"}, {"enable_special_config", false}, {"dcs", QJsonArray{QJsonObject{{"id", 2}, {"ip", "192.0.2.1"}, {"port", 4430}}}}};
	require(parse(tcp, &result) && result.websocketUrls.empty());
	for (const auto port : {0., 65536., 1.5, 1e100}) { auto bad = tcp; bad["port"] = port; require(!parse(bad, &result)); }
	{
		Configuration a, b;
		a.websocketUrls = {{1, "wss://a.test/a;2:wss://b.test/b"}, {2, "wss://c.test/c"}};
		b.websocketUrls = {{1, "wss://a.test/a"}, {2, "wss://b.test/b;2:wss://c.test/c"}};
		require(ConfigurationIdentity(a) != ConfigurationIdentity(b));
	}
	require(CanUseServerIdentity("official", "official", true, false));
	require(CanUseServerIdentity({}, "official", true, false)); // legacy official
	require(CanUseServerIdentity({}, identity, true, false)); // legacy TCP migration
	require(!CanUseServerIdentity({}, identity, true, true)); // no legacy WSS keys
	require(!CanUseServerIdentity("official", identity, true, true));
	require(!CanUseServerIdentity(identity, "official", true, false)); // deleted JSON
	require(!CanUseServerIdentity(identity, QByteArray(64, 'b'), true, true));
	require(!CanUseServerIdentity(identity, {}, false, true)); // invalid JSON
	require(CanUseServerIdentity(identity, identity, true, true));
	require(CanUseServerIdentity(identity, "official", false, false)); // cleared keys
}

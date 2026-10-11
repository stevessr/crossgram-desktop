#pragma once
#include <QtCore/QString>
#include <QtCore/QByteArray>
#include <vector>
#include <map>
#include <functional>

namespace Crossgram::ServerSwitch {
struct Configuration {
	struct Endpoint { int id; QString address; int port; };
	QString name;
	QString host;
	int port = 0;
	QByteArray rsaKey;
	std::vector<Endpoint> endpoints;
	bool enableSpecialConfig = false;
	std::map<int, QString> websocketUrls;
};
[[nodiscard]] QByteArray ConfigurationIdentity(const Configuration &config);
inline bool CanUseServerIdentity(const QByteArray &stored, const QByteArray &current, bool hasKeys, bool wss) {
	return !current.isEmpty() && (!hasKeys
		|| (stored.isEmpty() ? !wss : stored == current));
}
[[nodiscard]] bool ParseServerConfiguration(
	const QByteArray &json,
	Configuration *result,
	QString *error,
	const std::function<bool(const QByteArray &)> &validateRsa);
} // namespace Crossgram::ServerSwitch

#pragma once

#include <QtCore/QUrl>
#include <QtCore/QString>
#include <QtNetwork/QHostAddress>

namespace Crossgram {

// No credentials, fragments, literal IPs, whitespace or ambiguous URL repair.
// Query strings and explicit ports are retained, not reassembled by callers.
inline bool ParseWssUrl(const QString &text, QUrl *result) {
	if (text.isEmpty() || text.size() > 4096 || text.contains(u'\\')) return false;
	for (const auto ch : text) {
		if (ch.isSpace() || ch.unicode() < 0x20 || ch.unicode() == 0x7f) return false;
	}
	const auto authorityEnd = text.indexOf(u'/', text.indexOf(QStringLiteral("://")) + 3);
	const auto rawAuthority = text.left(authorityEnd < 0 ? text.size() : authorityEnd);
	if (rawAuthority.endsWith(u':')) return false;
	const auto url = QUrl(text, QUrl::StrictMode);
	if (!url.isValid() || url.isRelative() || url.scheme() != u"wss"
		|| url.host().isEmpty() || !QHostAddress(url.host()).isNull()
		|| url.authority().contains(u'@') || url.hasFragment()
		|| url.port(443) < 1 || url.port(443) > 65535
		|| url.path().isEmpty() || !url.path().startsWith(u'/')) return false;
	// Require a DNS name, not QUrl's permissive arbitrary reg-name syntax.
	const auto host = QUrl::toAce(url.host());
	if (host.size() > 253 || !host.contains('.')) return false;
	for (const auto &label : host.split('.')) {
		if (label.isEmpty() || label.size() > 63 || label.front() == '-'
			|| label.back() == '-') return false;
		for (const auto ch : label) {
			if (!(ch >= 'a' && ch <= 'z') && !(ch >= 'A' && ch <= 'Z')
				&& !(ch >= '0' && ch <= '9') && ch != '-') return false;
		}
	}
	*result = url;
	return true;
}

} // namespace Crossgram

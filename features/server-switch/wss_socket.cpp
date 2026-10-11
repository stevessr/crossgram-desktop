#include "crossgram/wss_socket.h"
#include "base/invoke_queued.h"
#include <QtCore/QtEndian>

namespace MTP::details {
WssSocket::WssSocket(not_null<QThread*> thread, QUrl url)
: AbstractSocket(thread), _url(std::move(url)) {
	_stream.moveToThread(thread);
	_stream.onConnected = [this] { InvokeQueued(this, [this] { _connected.fire({}); }); };
	_stream.onDisconnected = [this] { InvokeQueued(this, [this] { _disconnected.fire({}); }); };
	_stream.onReadyRead = [this] {
		// One pending notification, not one heap allocation per tiny WS frame.
		if (_readNotificationQueued) return;
		_readNotificationQueued = true;
		InvokeQueued(this, [this] {
			_readNotificationQueued = false;
			if (_stream.available()) _readyRead.fire({});
		});
	};
	_stream.onError = [this](const char *category) {
		LOG(("WSS transport error: %1").arg(QString::fromLatin1(category)));
		InvokeQueued(this, [this] { _error.fire({}); });
	};
}
void WssSocket::connectToHost(const QString &, int) { _stream.open(_url); }
bool WssSocket::isGoodStartNonce(bytes::const_span nonce) {
	// Same reserved-prefix exclusions as TcpSocket: server auto-detection must
	// identify the existing 64-byte obfuscation header, not plaintext framing.
	if (nonce.size() < 8) return false;
	const auto first = qFromUnaligned<quint32>(nonce.data());
	return gsl::to_integer<uchar>(nonce.front()) != 0xef
		&& first != 0x44414548U && first != 0x54534f50U
		&& first != 0x20544547U && first != 0xeeeeeeeeU
		&& first != 0xddddddddU && first != 0x02010316U
		&& qFromUnaligned<quint32>(nonce.data() + 4) != 0;
}
void WssSocket::timedOut() { _stream.timeout(); }
bool WssSocket::isConnected() { return _stream.connected(); }
bool WssSocket::hasBytesAvailable() { return _stream.available(); }
int64 WssSocket::read(bytes::span buffer) { return _stream.read(reinterpret_cast<char*>(buffer.data()), buffer.size()); }
void WssSocket::write(bytes::const_span prefix, bytes::const_span buffer) {
	_stream.write(reinterpret_cast<const char*>(prefix.data()), prefix.size(), reinterpret_cast<const char*>(buffer.data()), buffer.size());
}
int32 WssSocket::debugState() { return _stream.state(); }
QString WssSocket::debugPostfix() const { return u"/wss"_q; }
} // namespace MTP::details

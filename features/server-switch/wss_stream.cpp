#include "wss_stream.h"
#include "wss_url.h"

#include <QtNetwork/QNetworkProxy>
#include <QtNetwork/QSslConfiguration>
#include <QtNetwork/QSslSocket>
#include <algorithm>
#include <cstring>

namespace Crossgram {

WssStream::WssStream(QObject *parent) : QObject(parent) {
	_socket.setParent(this);
	_deadline.setParent(this);
	_writeDeadline.setParent(this);
	// The account's global Telegram proxy must not override a custom origin.
	_socket.setProxy(QNetworkProxy::NoProxy);
	_socket.setReadBufferSize(BufferLimit);
	_socket.setMaxAllowedIncomingFrameSize(BufferLimit);
	_socket.setMaxAllowedIncomingMessageSize(BufferLimit);
	_socket.setOutgoingFrameSize(FrameLimit);
	auto tls = QSslConfiguration::defaultConfiguration();
	tls.setPeerVerifyMode(QSslSocket::VerifyPeer);
	tls.setProtocol(QSsl::TlsV1_2OrLater);
	_socket.setSslConfiguration(tls);
	_deadline.setSingleShot(true);
	_writeDeadline.setSingleShot(true);
	connect(&_deadline, &QTimer::timeout, this, [this] { fail("connect-timeout"); });
	connect(&_writeDeadline, &QTimer::timeout, this, [this] { fail("write-timeout"); });
	connect(&_socket, &QWebSocket::connected, this, [this] {
		if (_finished) return;
		_deadline.stop();
		if (onConnected) onConnected();
	});
	connect(&_socket, &QWebSocket::disconnected, this, [this] {
		if (_finished) return;
		_finished = true;
		_deadline.stop();
		_writeDeadline.stop();
		_input.clear(); _output.clear();
		if (onDisconnected) onDisconnected();
	});
	connect(&_socket, &QWebSocket::sslErrors, this, [this] { fail("tls-certificate"); });
#if QT_VERSION >= QT_VERSION_CHECK(6, 5, 0)
	connect(&_socket, &QWebSocket::errorOccurred, this, [this](QAbstractSocket::SocketError e) {
#else
	connect(&_socket, qOverload<QAbstractSocket::SocketError>(&QWebSocket::error), this, [this](QAbstractSocket::SocketError e) {
#endif
		fail(e == QAbstractSocket::HostNotFoundError ? "dns"
			: e == QAbstractSocket::SslHandshakeFailedError ? "tls-handshake"
			: e == QAbstractSocket::ConnectionRefusedError ? "connect-refused"
			: e == QAbstractSocket::SocketTimeoutError ? "network-timeout"
			: e == QAbstractSocket::UnknownSocketError ? "upgrade-or-protocol"
			: "network-or-upgrade");
	});
	connect(&_socket, &QWebSocket::textFrameReceived, this, [this] { fail("non-binary"); });
	// Frame and message boundaries do not delimit MTProto packets.
	connect(&_socket, &QWebSocket::binaryFrameReceived, this, [this](const QByteArray &data, bool) {
		if (_finished || data.isEmpty()) return;
		if (data.size() > BufferLimit - (_input.size() - _readOffset)) {
			return fail("receive-overflow");
		}
		if (_readOffset) { _input.remove(0, _readOffset); _readOffset = 0; }
		_input.append(data);
		if (onReadyRead) onReadyRead();
	});
	connect(&_socket, &QWebSocket::bytesWritten, this, [this] {
		if (_finished) return;
		if (_socket.bytesToWrite() || !_output.isEmpty()) _writeDeadline.start(30000);
		else _writeDeadline.stop();
		drain();
	});
}

WssStream::~WssStream() { abort(); }

void WssStream::open(const QUrl &url) {
	QUrl checked;
	if (_opened || !ParseWssUrl(url.toString(QUrl::FullyEncoded), &checked)) return fail("invalid-url");
	_opened = true;
	_deadline.start(15000);
	// QWebSocket uses the URL hostname for DNS, TLS SNI and peer verification.
	_socket.open(checked);
}

void WssStream::abort() {
	_finished = true;
	_deadline.stop(); _writeDeadline.stop();
	_socket.abort();
	_input.clear(); _output.clear(); _readOffset = 0;
}
void WssStream::timeout() { fail("mtproto-timeout"); }
bool WssStream::connected() const { return !_finished && _socket.state() == QAbstractSocket::ConnectedState; }
bool WssStream::available() const { return _input.size() > _readOffset; }
int WssStream::state() const { return _socket.state(); }

qint64 WssStream::read(char *data, qint64 size) {
	const auto count = std::min<qint64>(size, _input.size() - _readOffset);
	if (count <= 0) return 0;
	std::memcpy(data, _input.constData() + _readOffset, count);
	_readOffset += count;
	if (_readOffset == _input.size()) { _input.clear(); _readOffset = 0; }
	return count;
}

void WssStream::write(const char *prefix, qint64 prefixSize, const char *data, qint64 size) {
	if (!connected()) return fail("write-not-connected");
	const auto remaining = BufferLimit - _output.size() - _socket.bytesToWrite();
	if (prefixSize < 0 || size < 0 || prefixSize > remaining || size > remaining - prefixSize) {
		return fail("send-overflow");
	}
	if (prefixSize) _output.append(prefix, prefixSize);
	if (size) _output.append(data, size);
	if (!_writeDeadline.isActive() && !_output.isEmpty()) _writeDeadline.start(30000);
	drain();
}

void WssStream::drain() {
	if (!connected()) return;
	while (!_output.isEmpty() && _socket.bytesToWrite() < FrameLimit) {
		const auto count = std::min<qint64>(FrameLimit, _output.size());
		const auto data = _output.first(count);
		_output.remove(0, count);
		if (_socket.sendBinaryMessage(data) != count) return fail("short-write");
	}
}

void WssStream::fail(const char *category) {
	if (_finished) return;
	abort();
	if (onError) onError(category);
}

} // namespace Crossgram

#include "wss_stream.h"
#include "wss_url.h"
#include <QtCore/QCoreApplication>
#include <QtCore/QElapsedTimer>
#include <QtCore/QFile>
#include <QtCore/QThread>
#include <QtNetwork/QSslKey>
#include <QtWebSockets/QWebSocketServer>
#include <iostream>
#include <stdexcept>

using Crossgram::WssStream;
void configTests();
void require(bool ok, const char *message) { if (!ok) throw std::runtime_error(message); }
void until(std::function<bool()> condition) {
	QElapsedTimer timer; timer.start();
	while (!condition() && timer.elapsed() < 5000) {
		QCoreApplication::processEvents(); QThread::msleep(1);
	}
	require(condition(), "event deadline exceeded");
}
QByteArray file(const char *name) { QFile f(QString::fromLocal8Bit(name)); require(f.open(QIODevice::ReadOnly), "fixture unreadable"); return f.readAll(); }
int main(int argc, char **argv) {
	QCoreApplication app(argc, argv);
	try {
		require(argc == 3, "usage: stream cert.pem key.pem");
		configTests();
		QUrl parsed;
		for (const auto &url : {"wss://x.example.test/mtproto", "wss://x.example.test:8443/a%20b?k=v%2Fz", "wss://例子.测试/mtproto"}) {
			require(Crossgram::ParseWssUrl(QString::fromUtf8(url), &parsed), url);
		}
		for (const auto &url : {"ws://x.example.test/mtproto", "https://x.example.test/mtproto", "wss://x.example.test", "wss://127.0.0.1/mtproto", "wss://[::1]/mtproto", "wss://user@x.example.test/mtproto", "wss://@x.example.test/a", "wss://x.example.test/a#", "wss://x.example.test:0/a", "wss://x.example.test:65536/a", "wss://x.example.test:abc/a", " wss://x.example.test/a", "wss://x.example.test/a\n", "wss://x.example.test/%zz", "wss://x.example.test/\\a", "wss://-x.example.test/a", "wss://a..test/a", "wss://localhost/a"}) {
			require(!Crossgram::ParseWssUrl(QString::fromUtf8(url), &parsed), url);
		}
		const auto cert = QSslCertificate(file(argv[1]));
		const auto key = QSslKey(file(argv[2]), QSsl::Rsa);
		const auto untrusted = QSslConfiguration::defaultConfiguration();
		auto trusted = untrusted;
		auto roots = trusted.caCertificates(); roots.append(cert); trusted.setCaCertificates(roots);
		QSslConfiguration::setDefaultConfiguration(trusted);
		QWebSocketServer server(QStringLiteral("fixture"), QWebSocketServer::SecureMode);
		auto tls = trusted; tls.setLocalCertificate(cert); tls.setPrivateKey(key); tls.setPeerVerifyMode(QSslSocket::VerifyNone);
		server.setSslConfiguration(tls);
		require(server.listen(QHostAddress::LocalHostIPv6, 0), "TLS fixture listen failed");
		const auto url = QUrl(QStringLiteral("wss://localhost.localdomain:%1/mtproto?dc=2").arg(server.serverPort()));
		QWebSocket *peer = nullptr;
		QByteArray received;
		QObject::connect(&server, &QWebSocketServer::newConnection, [&] {
			peer = server.nextPendingConnection(); peer->setParent(&server);
			require(peer->requestUrl().path() == QStringLiteral("/mtproto"), "path lost");
			require(peer->requestUrl().query() == QStringLiteral("dc=2"), "query lost");
			QObject::connect(peer, &QWebSocket::binaryMessageReceived, [&](const QByteArray &bytes) { received += bytes; });
		});
		{
			WssStream stream;
			std::string error;
			stream.onError = [&](const char *e) { error = e; };
			stream.open(url); until([&] { return stream.connected() && peer; });
			// Binary frames fragment a message, messages split/coalesce packets.
			peer->setOutgoingFrameSize(3);
			peer->sendBinaryMessage(QByteArray("\x7f\x01", 2));
			peer->sendBinaryMessage(QByteArray("\x00\x00payloadpacket2", 17));
			QByteArray read;
			stream.onReadyRead = [&] { char buf[2]; while (const auto n = stream.read(buf, 2)) read.append(buf, n); };
			until([&] { return read.size() == 19; });
			require(read == QByteArray("\x7f\x01\x00\x00payloadpacket2", 19), "stream order changed");
			const auto payload = QByteArray(1024 * 1024, 'x');
			stream.write("prefix", 6, payload.constData(), payload.size());
			until([&] { return received.size() == payload.size() + 6; });
			require(received == QByteArray("prefix") + payload, "queued send reordered");
			peer->sendTextMessage(QStringLiteral("not MTProto"));
			until([&] { return !error.empty(); });
			require(error == "non-binary" && !stream.connected(), "text accepted");
		}
		peer = nullptr;
		{
			WssStream stream; std::string error;
			stream.onError = [&](const char *e) { error = e; };
			stream.open(url); until([&] { return stream.connected() && peer; });
			stream.write(nullptr, 0, "x", WssStream::BufferLimit + 1);
			require(error == "send-overflow" && !stream.connected(), "send cap failed");
		}
		peer = nullptr;
		{
			WssStream stream; std::string error;
			stream.onError = [&](const char *e) { error = e; };
			stream.open(url); until([&] { return stream.connected() && peer; });
			stream.timeout(); require(error == "mtproto-timeout", "timeout lost");
		}
		peer = nullptr;
		{
			WssStream stream; bool closed = false;
			stream.onDisconnected = [&] { closed = true; };
			stream.open(url); until([&] { return stream.connected() && peer; });
			peer->close(); until([&] { return closed; });
			require(!stream.connected() && !stream.available(), "closed stream retained bytes");
		}
		peer = nullptr;
		{
			WssStream stream; std::string error;
			stream.onError = [&](const char *e) { error = e; };
			stream.open(url); until([&] { return stream.connected() && peer; });
			peer->setOutgoingFrameSize(WssStream::BufferLimit);
			peer->sendBinaryMessage(QByteArray(WssStream::BufferLimit, 'x'));
			until([&] { return stream.available(); }); // consumer intentionally stalled
			peer->sendBinaryMessage(QByteArray("x"));
			until([&] { return !error.empty(); });
			require(error == "receive-overflow", "receive cap failed");
		}
		QSslConfiguration::setDefaultConfiguration(untrusted);
		{
			WssStream stream; std::string error;
			stream.onError = [&](const char *e) { error = e; };
			stream.open(url); until([&] { return !error.empty(); });
			require(error == "tls-certificate" && !stream.connected(), "untrusted TLS accepted");
		}
		std::cout << "PASS strict URL, trusted TLS/SNI hostname, path/query, binary split/coalesced stream, ordered backpressure, send/receive caps, timeout, close, untrusted TLS\n";
		return 0;
	} catch (const std::exception &e) { std::cerr << "FAIL: " << e.what() << '\n'; return 1; }
}

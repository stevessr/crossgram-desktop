// Pre-authorization interoperability probe only. No login or chat operations.
#include "wss_stream.h"
#include <QtCore/QCoreApplication>
#include <QtCore/QDateTime>
#include <QtCore/QElapsedTimer>
#include <QtCore/QFile>
#include <QtCore/QThread>
#include <QtCore/QtEndian>
#include <QtNetwork/QSslConfiguration>
#include <QtNetwork/QSslCertificate>
#include <openssl/evp.h>
#include <openssl/rand.h>
#include <algorithm>
#include <iostream>
#include <stdexcept>

void check(bool ok, const char *text) { if (!ok) throw std::runtime_error(text); }
struct Ctr {
	EVP_CIPHER_CTX *ctx = EVP_CIPHER_CTX_new();
	Ctr(const char *key, const char *iv) { check(EVP_EncryptInit_ex(ctx, EVP_aes_256_ctr(), nullptr, reinterpret_cast<const unsigned char*>(key), reinterpret_cast<const unsigned char*>(iv)) == 1, "AES init"); }
	~Ctr() { EVP_CIPHER_CTX_free(ctx); }
	QByteArray apply(const QByteArray &plain) {
		QByteArray result(plain.size() + 16, 0); int length = 0;
		check(EVP_EncryptUpdate(ctx, reinterpret_cast<unsigned char*>(result.data()), &length, reinterpret_cast<const unsigned char*>(plain.constData()), plain.size()) == 1, "AES update");
		result.resize(length); return result;
	}
};
int main(int argc, char **argv) {
	QCoreApplication app(argc, argv);
	try {
		check(argc == 4, "usage: wss-req-pq wss-url trusted-cert fingerprint-hex");
		QFile file(QString::fromLocal8Bit(argv[2])); check(file.open(QIODevice::ReadOnly), "cert missing");
		auto ssl = QSslConfiguration::defaultConfiguration();
		auto roots = ssl.caCertificates(); roots.append(QSslCertificate(file.readAll())); ssl.setCaCertificates(roots);
		QSslConfiguration::setDefaultConfiguration(ssl);
		QByteArray header(64, 0); RAND_bytes(reinterpret_cast<unsigned char*>(header.data()), header.size());
		// Avoid plaintext protocol tags, as in TcpConnection's nonce predicate.
		header[0] = 0x42; header[4] = 1;
		auto reversed = header.mid(8, 48); std::reverse(reversed.begin(), reversed.end());
		Ctr send(header.constData() + 8, header.constData() + 40), receive(reversed.constData(), reversed.constData() + 32);
		qToLittleEndian<quint32>(0xefefefef, header.data() + 56);
		qToLittleEndian<quint16>(2, header.data() + 60);
		const auto encryptedHeader = send.apply(header);
		header.replace(56, 8, encryptedHeader.mid(56, 8));
		QByteArray packet(40, 0);
		qToLittleEndian<quint64>(quint64(QDateTime::currentSecsSinceEpoch()) << 32, packet.data() + 8);
		qToLittleEndian<quint32>(20, packet.data() + 16);
		qToLittleEndian<quint32>(0x60469778, packet.data() + 20);
		QByteArray nonce(16, 0); RAND_bytes(reinterpret_cast<unsigned char*>(nonce.data()), nonce.size()); packet.replace(24, 16, nonce);
		const auto wire = header + send.apply(QByteArray(1, 10) + packet);
		Crossgram::WssStream stream;
		std::string failure; QByteArray result; bool sent = false;
		stream.onError = [&](const char *category) { failure = category; };
		stream.onConnected = [&] {
			// Deliberately split both obfuscation preface and MTProto payload.
			stream.write(nullptr, 0, wire.constData(), 17);
			stream.write(nullptr, 0, wire.constData() + 17, 49);
			stream.write(nullptr, 0, wire.constData() + 66, wire.size() - 66);
			sent = true;
		};
		stream.onReadyRead = [&] { char buffer[7]; while (const auto n = stream.read(buffer, 7)) result += receive.apply(QByteArray(buffer, n)); };
		stream.open(QUrl(QString::fromLocal8Bit(argv[1]), QUrl::StrictMode));
		QElapsedTimer timer; timer.start();
		auto complete = [&] { return !result.isEmpty() && quint8(result[0]) < 0x7f && result.size() >= 1 + 4 * quint8(result[0]); };
		while (!complete() && failure.empty() && timer.elapsed() < 5000) { QCoreApplication::processEvents(); QThread::msleep(1); }
		check(sent && failure.empty() && complete(), failure.empty() ? "req_pq timeout" : failure.c_str());
		const auto plain = result.mid(1);
		check(plain.size() >= 60 && qFromLittleEndian<quint64>(plain.constData()) == 0, "auth key id");
		check(qFromLittleEndian<quint32>(plain.constData() + 20) == 0x05162463, "not resPQ");
		check(plain.mid(24, 16) == nonce, "nonce mismatch");
		const auto pqSize = quint8(plain[56]);
		const auto vectorOffset = 56 + ((1 + pqSize + 3) & ~3);
		check(vectorOffset + 16 <= plain.size(), "fingerprint vector missing");
		check(qFromLittleEndian<quint32>(plain.constData() + vectorOffset) == 0x1cb5c415, "vector tag");
		bool ok = false;
		const auto fingerprint = QString::fromLatin1(argv[3]).toULongLong(&ok, 16);
		check(ok && qFromLittleEndian<quint64>(plain.constData() + vectorOffset + 8) == fingerprint, "RSA fingerprint mismatch");
		std::cout << "PASS Qt WSS -> TLS loopback -> real CrossGram WebSocketBridge: obfuscated abridged req_pq/resPQ, nonce and RSA fingerprint\n";
		return 0;
	} catch (const std::exception &e) { std::cerr << e.what() << '\n'; return 1; }
}

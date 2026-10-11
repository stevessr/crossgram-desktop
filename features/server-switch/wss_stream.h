#pragma once

#include <QtCore/QObject>
#include <QtCore/QByteArray>
#include <QtCore/QTimer>
#include <QtCore/QUrl>
#include <QtWebSockets/QWebSocket>
#include <functional>

namespace Crossgram {

// One attempt only. SessionPrivate owns reconnection/backoff and MTProto pings.
// Never replay queued ciphertext on a new connection / AES-CTR state.
class WssStream final : public QObject {
public:
	static constexpr qint64 BufferLimit = 8 * 1024 * 1024;
	static constexpr qint64 FrameLimit = 256 * 1024;
	explicit WssStream(QObject *parent = nullptr);
	~WssStream() override;
	void open(const QUrl &url);
	void abort();
	void timeout();
	bool connected() const;
	qint64 read(char *data, qint64 size);
	bool available() const;
	void write(const char *prefix, qint64 prefixSize, const char *data, qint64 size);
	int state() const;

	std::function<void()> onConnected, onDisconnected, onReadyRead;
	// Stable categories; deliberately omit URL/query/remote error strings.
	std::function<void(const char*)> onError;
private:
	void fail(const char *category);
	void drain();
	QWebSocket _socket;
	QTimer _deadline;
	QTimer _writeDeadline;
	QByteArray _input;
	QByteArray _output;
	qsizetype _readOffset = 0;
	bool _finished = false;
	bool _opened = false;
};

} // namespace Crossgram

#pragma once
#include "mtproto/details/mtproto_abstract_socket.h"
#include "crossgram/wss_stream.h"

namespace MTP::details {
class WssSocket final : public AbstractSocket {
public:
	WssSocket(not_null<QThread*> thread, QUrl url);
	void connectToHost(const QString &, int) override;
	bool isGoodStartNonce(bytes::const_span nonce) override;
	void timedOut() override;
	bool isConnected() override;
	bool hasBytesAvailable() override;
	int64 read(bytes::span buffer) override;
	void write(bytes::const_span prefix, bytes::const_span buffer) override;
	int32 debugState() override;
	QString debugPostfix() const override;
private:
	Crossgram::WssStream _stream;
	QUrl _url;
	bool _readNotificationQueued = false;
};
} // namespace MTP::details



bool DcOptions::specialConfigEnabled() const {
	return _specialConfigEnabled;
}

bool DcOptions::useCustomConfiguration(
		const std::vector<Endpoint> &endpoints,
		const QByteArray &rsaKey,
		bool enableSpecialConfig,
		const std::map<DcId, QString> &websocketUrls) {
	auto parsed = RSAPublicKey(bytes::make_span(rsaKey));
	if (endpoints.empty() || !parsed.valid()) {
		return false;
	}

	auto data = base::flat_map<DcId, std::vector<Endpoint>>();
	for (const auto &endpoint : endpoints) {
		if (!ApplyOneOption(
				data,
				endpoint.id,
				endpoint.flags,
				endpoint.ip,
				endpoint.port,
				endpoint.secret)) {
			return false;
		}
	}

	const auto changed = [&] {
		ReadLocker lock(this);
		return CountOptionsDifference(_data, data);
	}();
	{
		WriteLocker lock(this);
		_data = std::move(data);
		_publicKeys.clear();
		_publicKeys.emplace(parsed.fingerprint(), std::move(parsed));
		_cdnPublicKeys.clear();
		_immutable = true;
		_serverSwitchBlocked = false;
		_specialConfigEnabled = enableSpecialConfig;
		_websocketUrls = websocketUrls;
	}
	for (const auto dcId : changed) {
		_changed.fire_copy(dcId);
	}
	return true;
}

void DcOptions::useBuiltInConfiguration() {
	{
		WriteLocker lock(this);
		_data.clear();
		_publicKeys.clear();
		_cdnPublicKeys.clear();
		_immutable = false;
		_serverSwitchBlocked = false;
		_specialConfigEnabled = true;
		_websocketUrls.clear();
	}
	constructFromBuiltIn();
}


bool DcOptions::websocketTransport() const {
	ReadLocker lock(this);
	return !_websocketUrls.empty();
}

QString DcOptions::websocketUrl(DcId dcId) const {
	ReadLocker lock(this);
	const auto i = _websocketUrls.find(dcId);
	return (i == _websocketUrls.end()) ? QString() : i->second;
}


void DcOptions::blockServerSwitchConfiguration() {
	WriteLocker lock(this);
	_serverSwitchBlocked = true;
	_immutable = true;
	_specialConfigEnabled = false;
	_data.clear();
	_websocketUrls.clear();
	_publicKeys.clear();
	_cdnPublicKeys.clear();
}

bool DcOptions::serverSwitchBlocked() const {
	ReadLocker lock(this);
	return _serverSwitchBlocked;
}

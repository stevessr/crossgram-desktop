void Account::start(std::unique_ptr<MTP::Config> config) {
	_appConfig = std::make_unique<AppConfig>(this);
	auto prepared = config
		? std::move(config)
		: std::make_unique<MTP::Config>(
			Core::App().fallbackProductionConfig());
	auto error = QString();
	auto identity = QByteArray();
	const auto applied = Crossgram::ServerSwitch::ApplyStored(
		_local->serverSwitchConfigPath(), &prepared->dcOptions(), &error, &identity);
	const auto hasKeys = !_mtpFields.keys.empty() || !_mtpKeysToDestroy.empty() || bool(_sessionUserId);
	if (!applied || !Crossgram::ServerSwitch::CanUseServerIdentity(_serverSwitchIdentity, identity,
			hasKeys, prepared->dcOptions().websocketTransport())) {
		LOG(("Server Switch Error: configuration invalid or server identity mismatch; this account is offline."));
		prepared->dcOptions().blockServerSwitchConfiguration();
		// Keep the original key binding: restoring the original JSON recovers it.
	} else {
		_serverSwitchIdentity = identity;
	}
	startMtp(std::move(prepared));
	local().writeMtpData();
	_appConfig->start();
	watchProxyChanges();
	watchSessionChanges();
}



bool Account::reloadServerSwitchConfiguration(QString *error) {
	if (sessionExists()) {
		if (error) {
			*error = u"Server can only be changed before signing in."_q;
		}
		return false;
	}
	auto identity = QByteArray();
	auto config = std::make_unique<MTP::Config>(_mtp->config());
	if (!Crossgram::ServerSwitch::ApplyStored(
			_local->serverSwitchConfigPath(),
			&config->dcOptions(),
			error, &identity)) {
		return false;
	}

	if (identity.isEmpty()) return false;
	_mtpForKeysDestroy = nullptr;
	_mtpKeysToDestroy.clear();
	_mtpFields.keys.clear();
	_mtpFields.mainDcId = MTP::Instance::Fields::kDefaultMainDc;
	_mtp = nullptr;
	_serverSwitchIdentity = identity;
	// Persist cleared keys with their new binding BEFORE opening a new origin.
	local().writeMtpData();
	startMtp(std::move(config));
	local().writeMtpData();
	local().writeMtpConfig();
	return true;
}

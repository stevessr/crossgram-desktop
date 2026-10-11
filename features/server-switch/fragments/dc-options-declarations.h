
	[[nodiscard]] bool specialConfigEnabled() const;
	[[nodiscard]] bool useCustomConfiguration(
		const std::vector<Endpoint> &endpoints,
		const QByteArray &rsaKey,
		bool enableSpecialConfig,
		const std::map<DcId, QString> &websocketUrls = {});
	void useBuiltInConfiguration();
	[[nodiscard]] bool websocketTransport() const;
	[[nodiscard]] QString websocketUrl(DcId dcId) const;

	void blockServerSwitchConfiguration();
	[[nodiscard]] bool serverSwitchBlocked() const;

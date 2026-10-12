
	_server->entity()->setTextTransform(Ui::RoundButtonTextTransform::ToUpper);
	_server->entity()->setClickedCallback([=] {
		Crossgram::ServerSwitch::OpenSelector(
			getData()->controller,
			_account);
	});

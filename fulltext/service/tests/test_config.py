import config


def test_defaults_match_f4():
    c = config.load({})
    assert (c.host, c.port, c.candidates) == ('127.0.0.1', 8765, 400)
    assert (c.max_concurrent, c.queue_max, c.timeout_s) == (4, 8, 3.0)


def test_env_overrides_and_zero_candidates_means_uncapped():
    c = config.load({'FT_CANDIDATES': '0', 'FT_PORT': '9000', 'FT_TIMEOUT_S': '1.5'})
    assert c.candidates == 0 and c.port == 9000 and c.timeout_s == 1.5

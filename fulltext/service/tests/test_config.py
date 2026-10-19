import config


def test_defaults():
    c = config.load({})
    assert (c.host, c.port, c.exact_scan) == ('127.0.0.1', 8765, 3000)
    assert (c.max_concurrent, c.queue_max, c.timeout_s) == (4, 8, 3.0)


def test_env_overrides():
    c = config.load({'FT_EXACT_SCAN': '100', 'FT_PORT': '9000', 'FT_TIMEOUT_S': '1.5',
                     'FT_TITLES': '/x/titles.json', 'FT_BOOST': '/x/boost.json'})
    assert (c.exact_scan, c.port, c.timeout_s) == (100, 9000, 1.5)
    assert (c.titles, c.boost) == ('/x/titles.json', '/x/boost.json')


def test_edge_token_from_env():
    assert config.load({}).edge_token == ''
    assert config.load({'FT_EDGE_TOKEN': 'x'}).edge_token == 'x'

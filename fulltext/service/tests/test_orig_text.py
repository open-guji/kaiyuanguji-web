import random

from common import orig_text, stream

CASES = ['', '天地，玄黃。', 'ABC def 123', ':zi[木目]林', '[[闕文]]下', '[木*目]', '{abcd}', '[4E00]',
         '〓字', '□〇', '𠀀豈', '\x00天[x]', '속天']


def ref(raw):
    return ''.join(stream(raw)[0])


def test_matches_stream_on_edge_cases():
    for raw in CASES:
        assert orig_text(raw) == ref(raw), raw


def test_matches_stream_on_random_mix():
    rnd = random.Random(20261018)
    alpha = list('天地ABCz9:[]{}*/〓\x00□〇，。 \n#豈속') + [':zi[木目]', '[[x]]', '[木*目]', '{abc}', '[4E00]', '𠀀']
    for _ in range(5000):
        raw = ''.join(rnd.choice(alpha) for _ in range(rnd.randint(0, 30)))
        assert orig_text(raw) == ref(raw), repr(raw)

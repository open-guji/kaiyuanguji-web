BLOCKS = [  # (key, name, lo, hi, assigned in Unicode 17)
 ('basic','基本区',0x4E00,0x9FFF,20992), ('A','扩A',0x3400,0x4DBF,6592), ('B','扩B',0x20000,0x2A6DF,42720),
 ('C','扩C',0x2A700,0x2B73F,4160), ('D','扩D',0x2B740,0x2B81F,222+1), ('E','扩E',0x2B820,0x2CEAF,5774),
 ('F','扩F',0x2CEB0,0x2EBEF,7473), ('I','扩I',0x2EBF0,0x2EE5F,622), ('G','扩G',0x30000,0x3134F,4939),
 ('H','扩H',0x31350,0x323AF,4192), ('J','扩J',0x323B0,0x3347F,4298),
 ('cmp','兼容区',0xF900,0xFAFF,472), ('cmpS','兼容补充',0x2F800,0x2FA1F,542),
 ('pua','PUA',0xE000,0xF8FF,6400), ('spua','补充PUA',0xF0000,0x10FFFF,0),
 ('ids','IDS符',0x2FF0,0x2FFF,16),
]
def block_of(cp):
    for k,n,a,b,_ in BLOCKS:
        if a<=cp<=b: return k
    return None

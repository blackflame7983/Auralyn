import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rustSuppressions } from './rust.mjs';

test('通常属性と条件付き・ネストしたallow/expectを検出する', () => {
    for (const source of [
        '#[allow(clippy::disallowed_methods)] fn unsafe_rt() {}',
        '#![expect(clippy::disallowed_types, reason = "legacy")]',
        '#[cfg_attr(not(test), allow(clippy::disallowed_methods))] fn unsafe_rt() {}',
        '#[cfg_attr(windows, cfg_attr(not(test), expect(clippy::disallowed_types)))] fn unsafe_rt() {}',
    ]) assert.equal(rustSuppressions(source).length, 1, source);
    assert.equal(rustSuppressions('#![cfg_attr(not(test), deny(clippy::disallowed_methods))]').length, 0);
});
